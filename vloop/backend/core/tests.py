import io
from datetime import timedelta
from django.core import mail
from django.contrib.auth.hashers import check_password, make_password
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone
from PIL import Image
from rest_framework import status
from rest_framework.test import APIClient

from .models import (
    Item,
    Message,
    PasswordResetToken,
    SecurityQuestionChallenge,
    SecurityVerificationAttempt,
    User,
)


class ItemTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(email='itemuser@vidyaacademy.ac.in', password='pass1234')
        self.client.force_authenticate(user=self.user)

    def test_create_item(self):
        data = {
            'title': 'Test Item',
            'description': 'A test item',
            'type': 'Sell',
            'category': 'Textbook',
            'price': 10.0,
        }
        response = self.client.post('/api/items/', data)
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(Item.objects.count(), 1)

    def test_list_items(self):
        Item.objects.create(
            title='Item1',
            description='desc',
            type='Sell',
            category='Textbook',
            price=5,
            owner=self.user,
        )
        response = self.client.get('/api/items/')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertGreaterEqual(len(response.data), 1)

    def test_update_item(self):
        item = Item.objects.create(
            title='Item2',
            description='desc',
            type='Sell',
            category='Textbook',
            price=5,
            owner=self.user,
        )
        response = self.client.patch(f'/api/items/{item.id}/', {'price': 20.0})
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        item.refresh_from_db()
        self.assertEqual(item.price, 20.0)

    def test_delete_item(self):
        item = Item.objects.create(
            title='Item3',
            description='desc',
            type='Sell',
            category='Textbook',
            price=5,
            owner=self.user,
        )
        response = self.client.delete(f'/api/items/{item.id}/')
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(Item.objects.count(), 0)

    def test_create_item_without_price(self):
        data = {
            'title': 'Test Item No Price',
            'description': 'A test item',
            'type': 'Sell',
            'category': 'Textbook',
            # price omitted
        }
        response = self.client.post('/api/items/', data)
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(Item.objects.count(), 1)
        self.assertIsNone(Item.objects.first().price)

    def test_update_item_partial_no_image(self):
        item = Item.objects.create(
            title='Item4',
            description='desc',
            type='Sell',
            category='Textbook',
            price=5,
            owner=self.user,
        )
        response = self.client.patch(f'/api/items/{item.id}/', {'price': 7.5})
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        item.refresh_from_db()
        self.assertEqual(item.price, 7.5)


class MessageTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.sender = User.objects.create_user(email='sender@vidyaacademy.ac.in', password='pass1234')
        self.receiver = User.objects.create_user(email='receiver@vidyaacademy.ac.in', password='pass1234')
        self.third_user = User.objects.create_user(email='third@vidyaacademy.ac.in', password='pass1234')
        self.client.force_authenticate(user=self.sender)

    def test_send_message(self):
        response = self.client.post('/api/messages/', {'receiver': self.receiver.id, 'content': 'Hello!'})
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(Message.objects.count(), 1)
        self.assertIsNotNone(Message.objects.first().delivered_at)

    def test_cannot_send_message_to_self(self):
        response = self.client.post('/api/messages/', {'receiver': self.sender.id, 'content': 'Hello me'})
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Message.objects.count(), 0)

    def test_list_messages(self):
        Message.objects.create(sender=self.sender, receiver=self.receiver, content='Hi')
        response = self.client.get('/api/messages/')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.data), 1)

    def test_conversations_endpoint(self):
        Message.objects.create(sender=self.sender, receiver=self.receiver, content='Hi receiver')
        Message.objects.create(sender=self.third_user, receiver=self.sender, content='Hi sender')
        response = self.client.get('/api/messages/conversations/')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.data), 2)
        self.assertEqual(response.data[0]['email'], self.third_user.email)

    def test_history_endpoint(self):
        Message.objects.create(sender=self.sender, receiver=self.receiver, content='one')
        Message.objects.create(sender=self.receiver, receiver=self.sender, content='two')
        Message.objects.create(sender=self.third_user, receiver=self.sender, content='ignore')
        response = self.client.get(f'/api/messages/history/{self.receiver.id}/')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual([message['content'] for message in response.data], ['one', 'two'])

    def test_history_marks_received_messages_seen(self):
        message = Message.objects.create(sender=self.receiver, receiver=self.sender, content='seen me', delivered_at=timezone.now())
        self.client.get(f'/api/messages/history/{self.receiver.id}/')
        message.refresh_from_db()
        self.assertIsNotNone(message.seen_at)

    def test_send_message_with_attachment_and_reply(self):
        original = Message.objects.create(sender=self.receiver, receiver=self.sender, content='original', delivered_at=timezone.now())
        file = SimpleUploadedFile('note.txt', b'hello world', content_type='text/plain')
        response = self.client.post('/api/messages/', {
            'receiver': self.receiver.id,
            'content': 'replying with file',
            'reply_to_id': original.id,
            'attachment': file,
        }, format='multipart')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        message = Message.objects.get(id=response.data['id'])
        self.assertEqual(message.reply_to_id, original.id)
        self.assertTrue(bool(message.attachment))

    def test_conversations_endpoint_includes_unread_count(self):
        Message.objects.create(sender=self.receiver, receiver=self.sender, content='unread one', delivered_at=timezone.now())
        response = self.client.get('/api/messages/conversations/')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data[0]['unread_count'], 1)

    def test_delete_for_me_hides_message_only_for_request_user(self):
        message = Message.objects.create(sender=self.sender, receiver=self.receiver, content='hide me')
        response = self.client.post(f'/api/messages/{message.id}/delete-for-me/')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        response = self.client.get(f'/api/messages/history/{self.receiver.id}/')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.data), 0)

        self.client.force_authenticate(user=self.receiver)
        response = self.client.get(f'/api/messages/history/{self.sender.id}/')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.data), 1)

    def test_delete_for_everyone_replaces_message_for_both_users(self):
        message = Message.objects.create(sender=self.sender, receiver=self.receiver, content='remove for all')
        response = self.client.post(f'/api/messages/{message.id}/delete-for-everyone/')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        response = self.client.get(f'/api/messages/history/{self.receiver.id}/')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data[0]['display_content'], 'This message was deleted.')

        self.client.force_authenticate(user=self.receiver)
        response = self.client.get(f'/api/messages/history/{self.sender.id}/')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data[0]['display_content'], 'This message was deleted.')

    def test_receiver_cannot_delete_for_everyone(self):
        message = Message.objects.create(sender=self.sender, receiver=self.receiver, content='no permission')
        self.client.force_authenticate(user=self.receiver)
        response = self.client.post(f'/api/messages/{message.id}/delete-for-everyone/')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_clear_chat_hides_entire_conversation_for_request_user(self):
        Message.objects.create(sender=self.sender, receiver=self.receiver, content='one')
        Message.objects.create(sender=self.receiver, receiver=self.sender, content='two')

        response = self.client.post('/api/messages/clear-chat/', {'partner_id': self.receiver.id})
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['hidden_count'], 2)

        response = self.client.get(f'/api/messages/history/{self.receiver.id}/')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.data), 0)


class ProfileTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(email='profile@vidyaacademy.ac.in', password='pass1234')
        self.client.force_authenticate(user=self.user)

    def test_get_profile(self):
        response = self.client.get('/api/profile/')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['email'], self.user.email)

    def test_get_profile_does_not_rewrite_recent_presence(self):
        recent_seen = timezone.now() - timedelta(seconds=30)
        self.user.last_seen_at = recent_seen
        self.user.save(update_fields=['last_seen_at'])

        response = self.client.get('/api/profile/')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.user.refresh_from_db()
        self.assertEqual(self.user.last_seen_at, recent_seen)

    def test_update_profile_details(self):
        response = self.client.patch('/api/profile/', {
            'first_name': 'Pooja',
            'last_name': 'Thomas',
            'phone_number': '+91 9876543210',
        })
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.user.refresh_from_db()
        self.assertEqual(self.user.first_name, 'Pooja')
        self.assertEqual(self.user.last_name, 'Thomas')
        self.assertEqual(self.user.phone_number, '+91 9876543210')

    def test_update_profile_picture(self):
        image_stream = io.BytesIO()
        Image.new('RGB', (12, 12), 'green').save(image_stream, format='PNG')
        image_stream.seek(0)
        image = SimpleUploadedFile('profile.png', image_stream.read(), content_type='image/png')

        response = self.client.patch('/api/profile/', {
            'profile_picture': image,
        }, format='multipart')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.user.refresh_from_db()
        self.assertTrue(bool(self.user.profile_picture))

    def test_clear_profile_picture(self):
        image_stream = io.BytesIO()
        Image.new('RGB', (12, 12), 'green').save(image_stream, format='PNG')
        image_stream.seek(0)
        image = SimpleUploadedFile('profile.png', image_stream.read(), content_type='image/png')
        self.client.patch('/api/profile/', {'profile_picture': image}, format='multipart')

        response = self.client.patch('/api/profile/', {'remove_profile_picture': True}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.user.refresh_from_db()
        self.assertFalse(bool(self.user.profile_picture))

    def test_update_profile_password(self):
        self.user.security_question = 'What is your favorite book?'
        self.user.security_answer_hash = make_password('hobbit')
        self.user.two_step_enabled = True
        self.user.save(update_fields=['security_question', 'security_answer_hash', 'two_step_enabled'])
        response = self.client.post('/api/profile/password/', {
            'current_password': 'pass1234',
            'new_password': 'newpass1234',
            'confirm_password': 'newpass1234',
            'security_answer': '  HOBBIT  ',
        })
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password('newpass1234'))

    def test_update_two_step_preference(self):
        response = self.client.post('/api/profile/two-step/', {
            'enabled': True,
            'security_question': 'What city were you born in?',
            'security_answer': ' Thrissur ',
        })
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.user.refresh_from_db()
        self.assertTrue(self.user.two_step_enabled)
        self.assertEqual(self.user.security_question, 'What city were you born in?')
        self.assertTrue(check_password('thrissur', self.user.security_answer_hash))

    def test_update_two_step_requires_security_question(self):
        response = self.client.post('/api/profile/two-step/', {'enabled': True})
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('error', response.data)

    def test_disable_two_step_requires_current_password(self):
        self.user.two_step_enabled = True
        self.user.security_question = 'What city were you born in?'
        self.user.security_answer_hash = make_password('thrissur')
        self.user.save(update_fields=['two_step_enabled', 'security_question', 'security_answer_hash'])

        response = self.client.post('/api/profile/two-step/', {'enabled': False})
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('error', response.data)

    def test_disable_two_step_with_current_password(self):
        self.user.two_step_enabled = True
        self.user.security_question = 'What city were you born in?'
        self.user.security_answer_hash = make_password('thrissur')
        self.user.save(update_fields=['two_step_enabled', 'security_question', 'security_answer_hash'])

        response = self.client.post('/api/profile/two-step/', {
            'enabled': False,
            'current_password': 'pass1234',
        })
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.user.refresh_from_db()
        self.assertFalse(self.user.two_step_enabled)

    def test_delete_account_requires_security_answer_when_enabled(self):
        self.user.security_question = 'What is your favorite book?'
        self.user.security_answer_hash = make_password('hobbit')
        self.user.two_step_enabled = True
        self.user.save(update_fields=['security_question', 'security_answer_hash', 'two_step_enabled'])

        response = self.client.post('/api/profile/delete-account/', {
            'current_password': 'pass1234',
            'security_answer': 'wrong',
        })
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertTrue(User.objects.filter(id=self.user.id).exists())

    def test_delete_account_succeeds(self):
        self.user.security_question = 'What is your favorite book?'
        self.user.security_answer_hash = make_password('hobbit')
        self.user.two_step_enabled = True
        self.user.save(update_fields=['security_question', 'security_answer_hash', 'two_step_enabled'])

        response = self.client.post('/api/profile/delete-account/', {
            'current_password': 'pass1234',
            'security_answer': '  HOBBIT ',
        })
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertFalse(User.objects.filter(id=self.user.id).exists())

class PasswordResetTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(email='reset@vidyaacademy.ac.in', password='pass1234')

    def test_forgot_password(self):
        response = self.client.post(
            '/api/forgot-password/',
            {'email': self.user.email},
            HTTP_REFERER='http://127.0.0.1:5500/vloop/frontend/login.html'
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn('/api/password-reset-link/', mail.outbox[0].body)
        self.assertEqual(PasswordResetToken.objects.filter(user=self.user, used_at__isnull=True).count(), 1)

    def test_password_reset_link_redirects_to_reset_page(self):
        token = PasswordResetToken.objects.create(
            user=self.user,
            token='redirecttoken123',
            expires_at=timezone.now() + timedelta(hours=1),
        )
        response = self.client.get(f'/api/password-reset-link/{token.token}/')
        self.assertEqual(response.status_code, status.HTTP_302_FOUND)
        self.assertEqual(response['Location'], f'/api/reset-password-page/?token={token.token}')

    def test_password_reset_page_serves_html(self):
        response = self.client.get('/api/reset-password-page/?token=sample')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertIn('Set New Password', response.content.decode())
        self.assertIn('http://127.0.0.1:5500/vloop/frontend/login.html', response.content.decode())

    def test_legacy_reset_password_html_route_serves_page(self):
        response = self.client.get('/reset-password.html?token=sample')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertIn('Set New Password', response.content.decode())

    def test_reset_password_updates_credentials(self):
        self.client.post(
            '/api/forgot-password/',
            {'email': self.user.email},
            HTTP_REFERER='http://127.0.0.1:5500/vloop/frontend/login.html'
        )
        reset_token = PasswordResetToken.objects.get(user=self.user, used_at__isnull=True)

        response = self.client.post('/api/reset-password/', {
            'token': reset_token.token,
            'password': 'newpass1234',
        })
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        reset_token.refresh_from_db()
        self.assertIsNotNone(reset_token.used_at)

        old_login = self.client.post('/api/login/', {
            'email': self.user.email,
            'password': 'pass1234',
        })
        self.assertEqual(old_login.status_code, status.HTTP_401_UNAUTHORIZED)

        new_login = self.client.post('/api/login/', {
            'email': self.user.email,
            'password': 'newpass1234',
        })
        self.assertEqual(new_login.status_code, status.HTTP_200_OK)

    def test_reset_password_rejects_used_token(self):
        token = PasswordResetToken.objects.create(
            user=self.user,
            token='usedtoken123',
            expires_at=timezone.now() + timedelta(hours=1),
            used_at=timezone.now(),
        )
        response = self.client.post('/api/reset-password/', {
            'token': token.token,
            'password': 'newpass1234',
        })
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)


class UserAuthTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.valid_email = 'test@vidyaacademy.ac.in'
        self.invalid_email = 'test@gmail.com'
        self.password = 'testpassword123'

    def test_register_valid_email(self):
        response = self.client.post(reverse('register'), {
            'email': self.valid_email,
            'password': self.password,
        })
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(User.objects.filter(email=self.valid_email).count(), 1)
        self.assertEqual(response.data['email'], self.valid_email)
        self.assertIn('access', response.data)
        self.assertIn('id', response.data)

    def test_register_normalizes_email(self):
        response = self.client.post(reverse('register'), {
            'email': '  TEST@VIDYAACADEMY.AC.IN  ',
            'password': self.password,
        })
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertTrue(User.objects.filter(email=self.valid_email).exists())
        self.assertEqual(response.data['email'], self.valid_email)

    def test_register_invalid_email(self):
        response = self.client.post(reverse('register'), {
            'email': self.invalid_email,
            'password': self.password,
        })
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('email', response.data)

    def test_login_valid_user(self):
        User.objects.create_user(email=self.valid_email, password=self.password)
        response = self.client.post(reverse('login'), {
            'email': self.valid_email,
            'password': self.password,
        })
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertIn('access', response.data)

    def test_login_accepts_trimmed_mixed_case_email(self):
        User.objects.create_user(email=self.valid_email, password=self.password)
        response = self.client.post(reverse('login'), {
            'email': '  TEST@VIDYAACADEMY.AC.IN  ',
            'password': self.password,
        })
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['email'], self.valid_email)

    def test_login_requires_security_question_when_two_step_enabled(self):
        user = User.objects.create_user(
            email=self.valid_email,
            password=self.password,
            two_step_enabled=True,
            security_question='What is your favorite book?',
            security_answer_hash=make_password('hobbit'),
        )
        response = self.client.post(reverse('login'), {
            'email': self.valid_email,
            'password': self.password,
        })
        self.assertEqual(response.status_code, status.HTTP_202_ACCEPTED)
        self.assertTrue(response.data['security_question_required'])
        self.assertIn('challenge_token', response.data)
        self.assertEqual(response.data['security_question'], 'What is your favorite book?')
        self.assertEqual(SecurityQuestionChallenge.objects.filter(user=user, used_at__isnull=True).count(), 1)

    def test_verify_security_question_returns_tokens(self):
        user = User.objects.create_user(
            email=self.valid_email,
            password=self.password,
            two_step_enabled=True,
            security_question='What is your favorite book?',
            security_answer_hash=make_password('hobbit'),
        )
        response = self.client.post(reverse('login'), {
            'email': self.valid_email,
            'password': self.password,
        })
        challenge_token = response.data['challenge_token']

        verify_response = self.client.post(reverse('verify_security_question'), {
            'challenge_token': challenge_token,
            'answer': '  HOBBIT  ',
        })
        self.assertEqual(verify_response.status_code, status.HTTP_200_OK)
        self.assertIn('access', verify_response.data)
        challenge = SecurityQuestionChallenge.objects.get(user=user, token=challenge_token)
        self.assertIsNotNone(challenge.used_at)

    def test_verify_security_question_rejects_wrong_answer(self):
        user = User.objects.create_user(
            email=self.valid_email,
            password=self.password,
            two_step_enabled=True,
            security_question='What is your favorite book?',
            security_answer_hash=make_password('hobbit'),
        )
        response = self.client.post(reverse('login'), {
            'email': self.valid_email,
            'password': self.password,
        })
        verify_response = self.client.post(reverse('verify_security_question'), {
            'challenge_token': response.data['challenge_token'],
            'answer': 'wrong',
        })
        self.assertEqual(verify_response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('error', verify_response.data)
        self.assertEqual(SecurityVerificationAttempt.objects.filter(user=user, purpose='login', success=False).count(), 1)

    def test_security_question_locks_after_five_wrong_attempts(self):
        User.objects.create_user(
            email=self.valid_email,
            password=self.password,
            two_step_enabled=True,
            security_question='What is your favorite book?',
            security_answer_hash=make_password('hobbit'),
        )
        response = self.client.post(reverse('login'), {
            'email': self.valid_email,
            'password': self.password,
        })
        challenge_token = response.data['challenge_token']

        final_response = None
        for _ in range(5):
            final_response = self.client.post(reverse('verify_security_question'), {
                'challenge_token': challenge_token,
                'answer': 'wrong',
            })

        self.assertEqual(final_response.status_code, status.HTTP_429_TOO_MANY_REQUESTS)
        challenge = SecurityQuestionChallenge.objects.get(token=challenge_token)
        self.assertIsNotNone(challenge.locked_until)

    def test_login_accepts_legacy_mixed_case_stored_email(self):
        user = User(email='TestUser@VidyaAcademy.ac.in')
        user.set_password(self.password)
        user.save()

        response = self.client.post(reverse('login'), {
            'email': 'testuser@vidyaacademy.ac.in',
            'password': self.password,
        })
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        user.refresh_from_db()
        self.assertEqual(user.email, 'testuser@vidyaacademy.ac.in')

    def test_login_invalid_email_domain(self):
        User.objects.create_user(email=self.invalid_email, password=self.password)
        response = self.client.post(reverse('login'), {
            'email': self.invalid_email,
            'password': self.password,
        })
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertIn('error', response.data)

    def test_login_wrong_password(self):
        User.objects.create_user(email=self.valid_email, password=self.password)
        response = self.client.post(reverse('login'), {
            'email': self.valid_email,
            'password': 'wrongpassword',
        })
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertIn('error', response.data)
