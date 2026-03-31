from datetime import timedelta
import logging
from rest_framework import status, viewsets, mixins
from rest_framework.decorators import api_view, permission_classes, action
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import IsAuthenticated, AllowAny
from rest_framework.parsers import MultiPartParser, FormParser, JSONParser
from rest_framework.response import Response
from rest_framework_simplejwt.tokens import RefreshToken
from django.contrib.auth.hashers import make_password, check_password
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.core.mail import send_mail
from django.conf import settings
from django.db.models import Q
from django.http import HttpResponse
from django.shortcuts import redirect
from django.urls import reverse
from django.utils.crypto import get_random_string
from django.utils import timezone
from .models import (
    User,
    Item,
    Message,
    PasswordResetToken,
    SecurityQuestionChallenge,
    SecurityVerificationAttempt,
)
from .serializers import UserSerializer, UserProfileSerializer, ItemSerializer, MessageSerializer

PRESENCE_WRITE_INTERVAL = timedelta(seconds=60)
SECURITY_CHALLENGE_TTL = timedelta(minutes=10)
SECURITY_CHALLENGE_LOCKOUT = timedelta(minutes=5)
SECURITY_MAX_FAILED_ATTEMPTS = 5

logger = logging.getLogger(__name__)


def build_auth_payload(user):
    refresh = RefreshToken.for_user(user)
    return {
        'id': user.id,
        'email': user.email,
        'refresh': str(refresh),
        'access': str(refresh.access_token),
    }


def build_password_reset_link(request, token):
    return request.build_absolute_uri(reverse('password_reset_link', kwargs={'token': token}))


def can_send_real_reset_email():
    backend = getattr(settings, 'EMAIL_BACKEND', '')
    if backend == 'django.core.mail.backends.console.EmailBackend':
        return False
    if backend == 'django.core.mail.backends.smtp.EmailBackend':
        return bool(
            settings.EMAIL_HOST_USER
            and settings.EMAIL_HOST_PASSWORD
            and settings.EMAIL_HOST_USER != 'your_email@gmail.com'
            and settings.EMAIL_HOST_PASSWORD != 'your_app_password'
        )
    return True


def get_reset_page_html():
    reset_page_path = settings.BASE_DIR.parent / 'frontend' / 'reset-password.html'
    html = reset_page_path.read_text(encoding='utf-8')
    return (
        html.replace('href="login.html"', f'href="{settings.FRONTEND_LOGIN_URL}"')
            .replace("window.location.href = 'login.html';", f"window.location.href = '{settings.FRONTEND_LOGIN_URL}';")
    )


def parse_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {'true', '1', 'yes', 'on'}
    return bool(value)


def normalize_security_text(value):
    return ' '.join(str(value or '').strip().split())


def normalize_security_answer(value):
    return normalize_security_text(value).lower()


def get_client_ip(request):
    forwarded_for = request.META.get('HTTP_X_FORWARDED_FOR', '')
    if forwarded_for:
        return forwarded_for.split(',')[0].strip()
    return request.META.get('REMOTE_ADDR') or None


def get_retry_after_seconds(challenge):
    if not challenge.locked_until:
        return 0
    remaining = int((challenge.locked_until - timezone.now()).total_seconds())
    return max(remaining, 0)


def log_security_attempt(request, user, challenge, purpose, success):
    SecurityVerificationAttempt.objects.create(
        user=user,
        challenge=challenge,
        purpose=purpose,
        ip_address=get_client_ip(request),
        success=success,
    )
    if not success:
        logger.warning(
            'Security verification failed',
            extra={
                'user_id': getattr(user, 'id', None),
                'email': getattr(user, 'email', ''),
                'purpose': purpose,
                'ip_address': get_client_ip(request),
            },
        )


def get_or_create_security_challenge(user, purpose):
    now = timezone.now()
    active = (
        SecurityQuestionChallenge.objects
        .filter(user=user, purpose=purpose, used_at__isnull=True)
        .order_by('-created_at')
        .first()
    )
    if active and active.expires_at > now:
        if active.question_snapshot != user.security_question:
            active.question_snapshot = user.security_question
            active.save(update_fields=['question_snapshot'])
        return active

    if active and active.expires_at <= now:
        active.used_at = now
        active.save(update_fields=['used_at'])

    return SecurityQuestionChallenge.objects.create(
        user=user,
        token=get_random_string(length=40),
        purpose=purpose,
        question_snapshot=user.security_question,
        expires_at=now + SECURITY_CHALLENGE_TTL,
    )


def verify_security_answer(request, user, purpose, answer, challenge=None):
    if not user.two_step_enabled:
        return None

    if not user.security_question or not user.security_answer_hash:
        user.two_step_enabled = False
        user.save(update_fields=['two_step_enabled'])
        return None

    challenge = challenge or get_or_create_security_challenge(user, purpose)
    now = timezone.now()

    if challenge.locked_until and challenge.locked_until > now:
        retry_after_seconds = get_retry_after_seconds(challenge)
        return Response(
            {
                'error': 'Too many incorrect answers. Try again after the cooldown ends.',
                'retry_after_seconds': retry_after_seconds,
                'security_question': challenge.question_snapshot,
            },
            status=status.HTTP_429_TOO_MANY_REQUESTS,
        )

    normalized_answer = normalize_security_answer(answer)
    if len(normalized_answer) < 3:
        return Response(
            {
                'error': 'Security answer must be at least 3 characters.',
                'security_question': challenge.question_snapshot,
            },
            status=status.HTTP_400_BAD_REQUEST,
        )

    if not check_password(normalized_answer, user.security_answer_hash):
        challenge.failed_attempts += 1
        update_fields = ['failed_attempts']
        remaining_attempts = max(SECURITY_MAX_FAILED_ATTEMPTS - challenge.failed_attempts, 0)
        response_status = status.HTTP_400_BAD_REQUEST
        payload = {
            'error': 'Incorrect answer.',
            'remaining_attempts': remaining_attempts,
            'security_question': challenge.question_snapshot,
        }

        if challenge.failed_attempts >= SECURITY_MAX_FAILED_ATTEMPTS:
            challenge.locked_until = now + SECURITY_CHALLENGE_LOCKOUT
            update_fields.append('locked_until')
            response_status = status.HTTP_429_TOO_MANY_REQUESTS
            payload = {
                'error': 'Too many incorrect answers. Try again after the cooldown ends.',
                'retry_after_seconds': get_retry_after_seconds(challenge),
                'security_question': challenge.question_snapshot,
            }

        challenge.save(update_fields=update_fields)
        log_security_attempt(request, user, challenge, purpose, success=False)
        return Response(payload, status=response_status)

    challenge.used_at = now
    challenge.locked_until = None
    challenge.save(update_fields=['used_at', 'locked_until'])
    log_security_attempt(request, user, challenge, purpose, success=True)
    return None


def update_presence(user):
    if not user or not getattr(user, 'is_authenticated', False):
        return
    now = timezone.now()
    if user.last_seen_at and now - user.last_seen_at < PRESENCE_WRITE_INTERVAL:
        return
    user.last_seen_at = now
    user.save(update_fields=['last_seen_at'])


def user_presence_payload(user, request=None):
    from .serializers import is_user_online, build_media_url
    display_name = user.get_full_name().strip() or user.email.split('@')[0]
    return {
        'id': user.id,
        'email': user.email,
        'display_name': display_name,
        'profile_picture_url': build_media_url(request, user.profile_picture),
        'is_online': is_user_online(user),
        'last_seen_at': user.last_seen_at.isoformat() if user.last_seen_at else None,
    }

# --- MESSAGES ---

class MessageViewSet(viewsets.GenericViewSet, mixins.ListModelMixin, mixins.CreateModelMixin):
    queryset = Message.objects.all().order_by('timestamp')
    serializer_class = MessageSerializer
    parser_classes = [JSONParser, MultiPartParser, FormParser]

    def get_permissions(self):
        if self.action in ['list', 'create']:
            return [IsAuthenticated()]
        return super().get_permissions()

    def get_queryset(self):
        user = self.request.user
        update_presence(user)
        partner_id = self.request.query_params.get('partner')
        queryset = (Message.objects.filter(sender=user) | Message.objects.filter(receiver=user)).exclude(hidden_for=user)
        queryset = queryset.order_by('timestamp')
        if partner_id:
            queryset = queryset.filter(sender_id=partner_id) | queryset.filter(receiver_id=partner_id)
            queryset = queryset.exclude(hidden_for=user).order_by('timestamp')
        return queryset.distinct()

    def perform_create(self, serializer):
        receiver = serializer.validated_data['receiver']
        if receiver == self.request.user:
            raise ValidationError({'receiver': 'You cannot send messages to yourself.'})
        reply_to = serializer.validated_data.get('reply_to')
        forwarded_from = serializer.validated_data.get('forwarded_from')

        if reply_to and {reply_to.sender_id, reply_to.receiver_id} != {self.request.user.id, receiver.id}:
            raise ValidationError({'reply_to_id': 'Reply target must belong to the same conversation.'})
        if forwarded_from and self.request.user.id not in [forwarded_from.sender_id, forwarded_from.receiver_id]:
            raise ValidationError({'forwarded_from_id': 'You can only forward messages from your own chats.'})

        serializer.save(sender=self.request.user, delivered_at=timezone.now())

    @action(detail=False, methods=['get'], permission_classes=[IsAuthenticated])
    def conversations(self, request):
        user = request.user
        update_presence(user)
        messages = self.get_queryset()
        conversations = {}

        for message in messages:
            partner = message.receiver if message.sender_id == user.id else message.sender
            existing = conversations.get(partner.id)
            last_message = 'This message was deleted.' if message.deleted_for_everyone else message.content
            if existing is None or message.timestamp > existing['timestamp']:
                conversations[partner.id] = {
                    'user_id': partner.id,
                    'email': partner.email,
                    'display_name': partner.get_full_name().strip() or partner.email.split('@')[0],
                    'profile_picture_url': request.build_absolute_uri(partner.profile_picture.url) if partner.profile_picture else '',
                    'is_online': bool(partner.last_seen_at and partner.last_seen_at >= timezone.now() - timedelta(minutes=2)),
                    'last_seen_at': partner.last_seen_at,
                    'last_message': last_message,
                    'last_message_status': 'seen' if message.seen_at else ('delivered' if message.delivered_at else 'sent'),
                    'last_sender_id': message.sender_id,
                    'unread_count': 0,
                    'timestamp': message.timestamp,
                }

        unread_messages = messages.filter(receiver=user, seen_at__isnull=True)
        unread_counts = {}
        for message in unread_messages:
            partner_id = message.sender_id
            unread_counts[partner_id] = unread_counts.get(partner_id, 0) + 1

        payload = sorted(conversations.values(), key=lambda item: item['timestamp'], reverse=True)
        for entry in payload:
            entry['timestamp'] = entry['timestamp'].isoformat()
            entry['last_seen_at'] = entry['last_seen_at'].isoformat() if entry['last_seen_at'] else None
            entry['unread_count'] = unread_counts.get(entry['user_id'], 0)

        return Response(payload)

    @action(detail=False, methods=['get'], url_path=r'history/(?P<user_id>\d+)', permission_classes=[IsAuthenticated])
    def history(self, request, user_id=None):
        update_presence(request.user)
        if not User.objects.filter(id=user_id).exists():
            return Response({'error': 'Conversation user not found.'}, status=status.HTTP_404_NOT_FOUND)

        messages = self.get_queryset().filter(sender_id=user_id) | self.get_queryset().filter(receiver_id=user_id)
        messages = messages.order_by('timestamp').distinct()
        messages.filter(sender_id=user_id, receiver=request.user, seen_at__isnull=True).update(seen_at=timezone.now())
        messages = messages.order_by('timestamp').distinct()
        serializer = self.get_serializer(messages, many=True)
        return Response(serializer.data)

    @action(detail=True, methods=['post'], permission_classes=[IsAuthenticated], url_path='delete-for-me')
    def delete_for_me(self, request, pk=None):
        message = self.get_object()
        if request.user.id not in [message.sender_id, message.receiver_id]:
            return Response({'error': 'You do not have access to this message.'}, status=status.HTTP_403_FORBIDDEN)

        message.hidden_for.add(request.user)
        return Response({'status': 'deleted_for_me', 'message_id': message.id})

    @action(detail=True, methods=['post'], permission_classes=[IsAuthenticated], url_path='delete-for-everyone')
    def delete_for_everyone(self, request, pk=None):
        message = self.get_object()
        if request.user.id != message.sender_id:
            return Response({'error': 'Only the sender can delete for everyone.'}, status=status.HTTP_403_FORBIDDEN)

        if message.deleted_for_everyone:
            return Response({'status': 'already_deleted', 'message_id': message.id})

        message.deleted_for_everyone = True
        message.deleted_at = timezone.now()
        message.save(update_fields=['deleted_for_everyone', 'deleted_at'])

        serializer = self.get_serializer(message)
        return Response({'status': 'deleted_for_everyone', 'message': serializer.data})

    @action(detail=False, methods=['post'], permission_classes=[IsAuthenticated], url_path='clear-chat')
    def clear_chat(self, request):
        partner_id = request.data.get('partner_id')
        if not partner_id or not User.objects.filter(id=partner_id).exists():
            return Response({'error': 'Conversation user not found.'}, status=status.HTTP_404_NOT_FOUND)

        messages = (
            Message.objects.filter(
                Q(sender=request.user, receiver_id=partner_id) |
                Q(sender_id=partner_id, receiver=request.user)
            )
            .exclude(hidden_for=request.user)
            .distinct()
        )

        hidden_count = 0
        for message in messages:
            message.hidden_for.add(request.user)
            hidden_count += 1

        return Response({'status': 'cleared', 'hidden_count': hidden_count})

# --- AUTHENTICATION ---
@api_view(['POST'])
@permission_classes([AllowAny])
def register_user(request):
    serializer = UserSerializer(data=request.data)
    if serializer.is_valid():
        user = serializer.save()
        payload = build_auth_payload(user)
        payload['user'] = UserProfileSerializer(user, context={'request': request}).data
        return Response(payload, status=status.HTTP_201_CREATED)
    return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

@api_view(['POST'])
@permission_classes([AllowAny])
def login_user(request):
    email = str(request.data.get('email', '')).strip().lower()
    password = request.data.get('password')
    if not email or not email.endswith('@vidyaacademy.ac.in'):
        return Response({'error': 'Only @vidyaacademy.ac.in emails are allowed.'}, status=status.HTTP_401_UNAUTHORIZED)
    try:
        user = User.objects.get(email__iexact=email)
    except User.DoesNotExist:
        return Response({'error': 'Invalid credentials'}, status=status.HTTP_401_UNAUTHORIZED)

    if user.check_password(password) and user.is_active:
        if user.email != user.email.strip().lower():
            user.email = user.email.strip().lower()
            user.save(update_fields=['email'])
        if user.two_step_enabled and (not user.security_question or not user.security_answer_hash):
            user.two_step_enabled = False
            user.save(update_fields=['two_step_enabled'])
        if user.two_step_enabled:
            challenge = get_or_create_security_challenge(user, SecurityQuestionChallenge.PURPOSE_LOGIN)
            return Response({
                'security_question_required': True,
                'challenge_token': challenge.token,
                'email': user.email,
                'security_question': challenge.question_snapshot,
                'message': 'Answer your security question to continue.',
                'retry_after_seconds': get_retry_after_seconds(challenge),
            }, status=status.HTTP_202_ACCEPTED)
        return Response(build_auth_payload(user))
    return Response({'error': 'Invalid credentials'}, status=status.HTTP_401_UNAUTHORIZED)


@api_view(['POST'])
@permission_classes([AllowAny])
def verify_security_question(request):
    challenge_token = str(request.data.get('challenge_token', '')).strip()
    answer = request.data.get('answer')

    if not challenge_token:
        return Response({'error': 'Security verification session not found.'}, status=status.HTTP_400_BAD_REQUEST)

    try:
        challenge = SecurityQuestionChallenge.objects.select_related('user').get(
            token=challenge_token,
            purpose=SecurityQuestionChallenge.PURPOSE_LOGIN,
            used_at__isnull=True,
        )
    except SecurityQuestionChallenge.DoesNotExist:
        return Response({'error': 'Invalid or expired security question request.'}, status=status.HTTP_400_BAD_REQUEST)

    if challenge.expires_at <= timezone.now():
        return Response({'error': 'Security question session expired. Please log in again.'}, status=status.HTTP_400_BAD_REQUEST)

    verification_error = verify_security_answer(
        request,
        challenge.user,
        SecurityQuestionChallenge.PURPOSE_LOGIN,
        answer,
        challenge=challenge,
    )
    if verification_error:
        return verification_error

    return Response(build_auth_payload(challenge.user))

@api_view(['POST'])
@permission_classes([AllowAny])
def forgot_password(request):
    email = str(request.data.get('email', '')).strip().lower()
    if not can_send_real_reset_email():
        return Response(
            {'error': 'Password reset email is not configured yet. Add real SMTP credentials in backend/.env first.'},
            status=status.HTTP_503_SERVICE_UNAVAILABLE
        )
    try:
        user = User.objects.get(email__iexact=email)
        if user.email != user.email.strip().lower():
            user.email = user.email.strip().lower()
            user.save(update_fields=['email'])
        token = get_random_string(length=32)
        PasswordResetToken.objects.filter(user=user, used_at__isnull=True).update(used_at=timezone.now())
        reset_token = PasswordResetToken.objects.create(
            user=user,
            token=token,
            expires_at=timezone.now() + timedelta(hours=1),
        )
        
        # Send Email
        reset_link = build_password_reset_link(request, reset_token.token)
        send_mail(
            'V-Loop Password Reset',
            f'Click the link to reset your password: {reset_link}',
            settings.DEFAULT_FROM_EMAIL,
            [email],
            fail_silently=False,
        )
        return Response({'message': 'Password reset email sent'})
    except User.DoesNotExist:
        return Response({'error': 'User with this email does not exist'}, status=status.HTTP_404_NOT_FOUND)


@api_view(['GET'])
@permission_classes([AllowAny])
def password_reset_link(request, token):
    return redirect(f"{reverse('password_reset_page')}?token={token}")


@api_view(['GET'])
@permission_classes([AllowAny])
def password_reset_page(request):
    return HttpResponse(get_reset_page_html())


@api_view(['GET', 'PATCH'])
@permission_classes([IsAuthenticated])
def profile(request):
    if request.method == 'GET':
        serializer = UserProfileSerializer(request.user, context={'request': request})
        return Response(serializer.data)

    payload = request.data.copy()
    remove_profile_picture = parse_bool(payload.get('remove_profile_picture'))
    if 'remove_profile_picture' in payload:
        payload.pop('remove_profile_picture')

    if remove_profile_picture and not request.data.get('profile_picture'):
        if request.user.profile_picture:
            request.user.profile_picture.delete(save=False)
        request.user.profile_picture = None
        request.user.save(update_fields=['profile_picture'])

    serializer = UserProfileSerializer(request.user, data=payload, partial=True, context={'request': request})
    if serializer.is_valid():
        serializer.save()
        return Response(serializer.data)
    return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def update_profile_password(request):
    current_password = request.data.get('current_password')
    new_password = request.data.get('new_password')
    confirm_password = request.data.get('confirm_password')

    if not current_password or not new_password or not confirm_password:
        return Response({'error': 'Fill in all password fields.'}, status=status.HTTP_400_BAD_REQUEST)

    if not request.user.check_password(current_password):
        return Response({'error': 'Current password is incorrect.'}, status=status.HTTP_400_BAD_REQUEST)

    if new_password != confirm_password:
        return Response({'error': 'New passwords do not match.'}, status=status.HTTP_400_BAD_REQUEST)

    verification_error = verify_security_answer(
        request,
        request.user,
        SecurityQuestionChallenge.PURPOSE_PASSWORD_CHANGE,
        request.data.get('security_answer'),
    )
    if verification_error:
        return verification_error

    try:
        validate_password(new_password, request.user)
    except DjangoValidationError as exc:
        return Response({'error': exc.messages[0]}, status=status.HTTP_400_BAD_REQUEST)

    request.user.set_password(new_password)
    request.user.save(update_fields=['password'])
    return Response({'message': 'Password updated successfully.'})


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def update_two_step(request):
    enabled = parse_bool(request.data.get('enabled'))
    disabling_two_step = request.user.two_step_enabled and not enabled
    if disabling_two_step:
        current_password = request.data.get('current_password')
        if not current_password:
            return Response(
                {'error': 'Enter your current password to disable 2-step verification.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not request.user.check_password(current_password):
            return Response(
                {'error': 'Current password is incorrect.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

    security_question = normalize_security_text(request.data.get('security_question'))
    security_answer = normalize_security_answer(request.data.get('security_answer'))
    has_new_question = 'security_question' in request.data and bool(security_question)
    has_new_answer = 'security_answer' in request.data and bool(str(request.data.get('security_answer', '')).strip())
    question_changed = has_new_question and security_question != request.user.security_question
    should_update_question = question_changed or has_new_answer or (enabled and not request.user.security_answer_hash)

    if should_update_question:
        if not security_question:
            return Response({'error': 'Security question cannot be empty.'}, status=status.HTTP_400_BAD_REQUEST)
        if len(security_answer) < 3:
            return Response({'error': 'Security answer must be at least 3 characters.'}, status=status.HTTP_400_BAD_REQUEST)
        request.user.security_question = security_question
        request.user.security_answer_hash = make_password(security_answer)

    if enabled and (not request.user.security_question or not request.user.security_answer_hash):
        return Response(
            {'error': 'Set a security question and answer before enabling 2-step verification.'},
            status=status.HTTP_400_BAD_REQUEST,
        )

    request.user.two_step_enabled = enabled
    request.user.save(update_fields=['two_step_enabled', 'security_question', 'security_answer_hash'])
    return Response({
        'message': '2-step verification disabled.' if disabling_two_step else 'Security question saved.',
        'two_step_enabled': request.user.two_step_enabled,
        'security_question': request.user.security_question,
        'has_security_question': bool(request.user.security_question and request.user.security_answer_hash),
    })


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def delete_account(request):
    current_password = request.data.get('current_password')
    if not current_password:
        return Response({'error': 'Enter your current password to delete the account.'}, status=status.HTTP_400_BAD_REQUEST)

    if not request.user.check_password(current_password):
        return Response({'error': 'Current password is incorrect.'}, status=status.HTTP_400_BAD_REQUEST)

    verification_error = verify_security_answer(
        request,
        request.user,
        SecurityQuestionChallenge.PURPOSE_DELETE_ACCOUNT,
        request.data.get('security_answer'),
    )
    if verification_error:
        return verification_error

    request.user.delete()
    return Response({'message': 'Your account has been deleted.'})

@api_view(['POST'])
@permission_classes([AllowAny])
def reset_password(request):
    token = str(request.data.get('token', '')).strip()
    new_password = request.data.get('password')

    if not token:
        return Response({'error': 'Invalid or expired token'}, status=status.HTTP_400_BAD_REQUEST)

    if not new_password:
        return Response({'error': 'Password is required.'}, status=status.HTTP_400_BAD_REQUEST)

    try:
        reset_token = PasswordResetToken.objects.select_related('user').get(token=token, used_at__isnull=True)
    except PasswordResetToken.DoesNotExist:
        return Response({'error': 'Invalid or expired token'}, status=status.HTTP_400_BAD_REQUEST)

    if reset_token.expires_at <= timezone.now():
        return Response({'error': 'Invalid or expired token'}, status=status.HTTP_400_BAD_REQUEST)

    try:
        validate_password(new_password, reset_token.user)
    except DjangoValidationError as exc:
        return Response({'error': exc.messages[0]}, status=status.HTTP_400_BAD_REQUEST)

    user = reset_token.user
    user.set_password(new_password)
    user.save(update_fields=['password'])
    reset_token.used_at = timezone.now()
    reset_token.save(update_fields=['used_at'])
    return Response({'message': 'Password has been reset successfully'})


# --- ITEMS ---

class ItemViewSet(viewsets.ModelViewSet):
    queryset = Item.objects.all().order_by('-created_at')
    serializer_class = ItemSerializer
    
    def get_permissions(self):
        if self.action in ['list', 'retrieve']:
            permission_classes = [AllowAny]
        else:
            permission_classes = [IsAuthenticated]
        return [permission() for permission in permission_classes]

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)
        
    def get_queryset(self):
        queryset = Item.objects.all().order_by('-created_at')
        type_param = self.request.query_params.get('type', None)
        search_param = self.request.query_params.get('search', None)
        
        if type_param and type_param != 'all':
            queryset = queryset.filter(type__iexact=type_param)
        if search_param:
            queryset = queryset.filter(title__icontains=search_param)
            
        return queryset

    def update(self, request, *args, **kwargs):
        instance = self.get_object()
        if instance.owner != request.user:
            return Response({'error': 'You can only edit your own items'}, status=status.HTTP_403_FORBIDDEN)
        return super().update(request, *args, **kwargs)

    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()
        if instance.owner != request.user:
            return Response({'error': 'You can only delete your own items'}, status=status.HTTP_403_FORBIDDEN)
        return super().destroy(request, *args, **kwargs)
