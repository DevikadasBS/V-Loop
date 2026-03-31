import json
from datetime import timedelta
from urllib.parse import parse_qs
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from rest_framework_simplejwt.tokens import AccessToken
from rest_framework_simplejwt.exceptions import InvalidToken, TokenError
from django.utils import timezone
from .models import Message, User

PRESENCE_WRITE_INTERVAL = timedelta(seconds=60)

class ChatConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.sender_id = self.scope['url_route']['kwargs']['sender_id']
        self.receiver_id = self.scope['url_route']['kwargs']['receiver_id']
        self.user = await self.get_authenticated_user()

        if not self.user:
            await self.close(code=4001)
            return

        if int(self.sender_id) != self.user.id:
            await self.close(code=4003)
            return

        receiver_exists = await self.user_exists(self.receiver_id)
        if not receiver_exists:
            await self.close(code=4004)
            return

        ids = [int(self.sender_id), int(self.receiver_id)]
        ids.sort()
        self.room_group_name = f'chat_{ids[0]}_{ids[1]}'

        await self.channel_layer.group_add(
            self.room_group_name,
            self.channel_name
        )
        await self.touch_last_seen(self.user.id)
        await self.accept()

    async def disconnect(self, close_code):
        if getattr(self, 'user', None):
            await self.touch_last_seen(self.user.id)
        await self.channel_layer.group_discard(
            self.room_group_name,
            self.channel_name
        )

    async def receive(self, text_data):
        data = json.loads(text_data)
        event_type = data.get('type', 'message')
        sender_id = data.get('sender_id')
        receiver_id = data.get('receiver_id')

        if int(sender_id) != self.user.id or int(receiver_id) != int(self.receiver_id):
            await self.close(code=4003)
            return

        if event_type == 'typing':
            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    'type': 'typing_event',
                    'sender_id': int(sender_id),
                    'sender_email': self.user.email,
                    'sender_display_name': self.user.get_full_name().strip() or self.user.email.split('@')[0],
                    'is_typing': bool(data.get('is_typing', False)),
                }
            )
            return

        if event_type == 'delete_for_me':
            message_data = await self.delete_for_me(data.get('message_id'), int(sender_id))
            if message_data:
                await self.send(text_data=json.dumps({
                    'type': 'message_deleted_for_me',
                    **message_data,
                }))
            return

        if event_type == 'delete_for_everyone':
            message_data = await self.delete_for_everyone(data.get('message_id'), int(sender_id))
            if message_data:
                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        'type': 'delete_everyone_event',
                        'message_data': message_data,
                    }
                )
            return

        message = data.get('message', '')
        if not message.strip():
            return

        message_data = await self.save_message(sender_id, receiver_id, message, data.get('reply_to_id'))

        await self.channel_layer.group_send(
            self.room_group_name,
            {
                'type': 'chat_message_event',
                'message_data': message_data
            }
        )

    async def chat_message_event(self, event):
        await self.send(text_data=json.dumps(event['message_data']))

    async def typing_event(self, event):
        await self.send(text_data=json.dumps({
            'type': 'typing',
            'sender_id': event['sender_id'],
            'sender_email': event['sender_email'],
            'sender_display_name': event.get('sender_display_name'),
            'is_typing': event['is_typing'],
        }))

    async def delete_everyone_event(self, event):
        await self.send(text_data=json.dumps({
            'type': 'message_deleted_for_everyone',
            **event['message_data'],
        }))

    @database_sync_to_async
    def save_message(self, sender_id, receiver_id, content, reply_to_id=None):
        sender = User.objects.get(id=sender_id)
        receiver = User.objects.get(id=receiver_id)
        reply_to = None
        if reply_to_id:
            reply_to = Message.objects.filter(id=reply_to_id).first()
        message = Message.objects.create(
            sender=sender,
            receiver=receiver,
            content=content,
            reply_to=reply_to,
            delivered_at=timezone.now(),
        )
        return self.serialize_message(message)

    @database_sync_to_async
    def user_exists(self, user_id):
        return User.objects.filter(id=user_id).exists()

    @database_sync_to_async
    def touch_last_seen(self, user_id):
        now = timezone.now()
        user = User.objects.filter(id=user_id).only('id', 'last_seen_at').first()
        if not user:
            return
        if user.last_seen_at and now - user.last_seen_at < PRESENCE_WRITE_INTERVAL:
            return
        User.objects.filter(id=user_id).update(last_seen_at=now)

    @database_sync_to_async
    def get_user_from_token(self, token):
        validated_token = AccessToken(token)
        user_id = validated_token['user_id']
        return User.objects.get(id=user_id)

    async def get_authenticated_user(self):
        try:
            query_string = self.scope.get('query_string', b'').decode()
            token = parse_qs(query_string).get('token', [None])[0]
            if not token:
                return None
            return await self.get_user_from_token(token)
        except (InvalidToken, TokenError, User.DoesNotExist, KeyError):
            return None

    @database_sync_to_async
    def delete_for_me(self, message_id, user_id):
        try:
            message = Message.objects.get(id=message_id)
        except Message.DoesNotExist:
            return None

        if user_id not in [message.sender_id, message.receiver_id]:
            return None

        message.hidden_for.add(user_id)
        return {
            'message_id': message.id,
        }

    @database_sync_to_async
    def delete_for_everyone(self, message_id, user_id):
        try:
            message = Message.objects.get(id=message_id)
        except Message.DoesNotExist:
            return None

        if message.sender_id != user_id or message.deleted_for_everyone:
            return None

        message.deleted_for_everyone = True
        message.deleted_at = timezone.now()
        message.save(update_fields=['deleted_for_everyone', 'deleted_at'])
        return self.serialize_message(message)

    def serialize_message(self, message):
        sender_display_name = message.sender.get_full_name().strip() or message.sender.email.split('@')[0]
        receiver_display_name = message.receiver.get_full_name().strip() or message.receiver.email.split('@')[0]
        reply_preview = None
        if message.reply_to:
            reply_preview = {
                'id': message.reply_to.id,
                'sender_id': message.reply_to.sender_id,
                'sender_display_name': message.reply_to.sender.get_full_name().strip() or message.reply_to.sender.email.split('@')[0],
                'content': 'This message was deleted.' if message.reply_to.deleted_for_everyone else (message.reply_to.content or ''),
                'attachment_name': message.reply_to.attachment.name.split('/')[-1] if message.reply_to.attachment else '',
            }
        forwarded_preview = None
        if message.forwarded_from:
            forwarded_preview = {
                'id': message.forwarded_from.id,
                'sender_id': message.forwarded_from.sender_id,
                'sender_display_name': message.forwarded_from.sender.get_full_name().strip() or message.forwarded_from.sender.email.split('@')[0],
                'content': 'This message was deleted.' if message.forwarded_from.deleted_for_everyone else (message.forwarded_from.content or ''),
                'attachment_name': message.forwarded_from.attachment.name.split('/')[-1] if message.forwarded_from.attachment else '',
            }
        return {
            'type': 'message',
            'id': message.id,
            'message': 'This message was deleted.' if message.deleted_for_everyone else message.content,
            'content': message.content,
            'display_content': 'This message was deleted.' if message.deleted_for_everyone else message.content,
            'attachment_url': message.attachment.url if message.attachment else '',
            'attachment_name': message.attachment.name.split('/')[-1] if message.attachment else '',
            'attachment_is_image': bool(message.attachment and message.attachment.name.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.webp'))),
            'reply_preview': reply_preview,
            'forwarded_preview': forwarded_preview,
            'forwarded_from_id': message.forwarded_from_id,
            'reply_to_id': message.reply_to_id,
            'status': 'seen' if message.seen_at else ('delivered' if message.delivered_at else 'sent'),
            'delivered_at': message.delivered_at.isoformat() if message.delivered_at else None,
            'seen_at': message.seen_at.isoformat() if message.seen_at else None,
            'deleted_for_everyone': message.deleted_for_everyone,
            'deleted_at': message.deleted_at.isoformat() if message.deleted_at else None,
            'can_delete_for_everyone': not message.deleted_for_everyone,
            'sender_id': message.sender_id,
            'receiver_id': message.receiver_id,
            'sender_email': message.sender.email,
            'sender_display_name': sender_display_name,
            'sender_profile_picture_url': message.sender.profile_picture.url if message.sender.profile_picture else '',
            'sender_is_online': bool(message.sender.last_seen_at and message.sender.last_seen_at >= timezone.now() - timedelta(minutes=2)),
            'sender_last_seen_at': message.sender.last_seen_at.isoformat() if message.sender.last_seen_at else None,
            'receiver_email': message.receiver.email,
            'receiver_display_name': receiver_display_name,
            'receiver_profile_picture_url': message.receiver.profile_picture.url if message.receiver.profile_picture else '',
            'receiver_is_online': bool(message.receiver.last_seen_at and message.receiver.last_seen_at >= timezone.now() - timedelta(minutes=2)),
            'receiver_last_seen_at': message.receiver.last_seen_at.isoformat() if message.receiver.last_seen_at else None,
            'timestamp': message.timestamp.isoformat(),
        }
