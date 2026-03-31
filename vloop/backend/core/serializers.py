from rest_framework import serializers
from .models import User, Item, Message


def build_media_url(request, file_field):
    if not file_field:
        return ''
    if request:
        return request.build_absolute_uri(file_field.url)
    return file_field.url


def is_user_online(user):
    if not user.last_seen_at:
        return False
    from django.utils import timezone
    from datetime import timedelta
    return user.last_seen_at >= timezone.now() - timedelta(minutes=2)

class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ['id', 'email', 'password']
        extra_kwargs = {'password': {'write_only': True}}

    def validate_email(self, value):
        value = value.strip().lower()
        if not value.endswith('@vidyaacademy.ac.in'):
            raise serializers.ValidationError("Only @vidyaacademy.ac.in emails are allowed.")
        existing_user = User.objects.filter(email__iexact=value)
        if self.instance:
            existing_user = existing_user.exclude(pk=self.instance.pk)
        if existing_user.exists():
            raise serializers.ValidationError("An account with this email already exists.")
        return value

    def create(self, validated_data):
        user = User.objects.create_user(**validated_data)
        return user


class UserProfileSerializer(serializers.ModelSerializer):
    full_name = serializers.SerializerMethodField()
    profile_picture_url = serializers.SerializerMethodField()
    is_online = serializers.SerializerMethodField()
    has_security_question = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = [
            'id',
            'email',
            'phone_number',
            'first_name',
            'last_name',
            'full_name',
            'profile_picture',
            'profile_picture_url',
            'two_step_enabled',
            'security_question',
            'has_security_question',
            'last_seen_at',
            'is_online',
            'date_joined',
        ]
        read_only_fields = ['email', 'date_joined', 'security_question', 'has_security_question', 'two_step_enabled']

    def get_full_name(self, obj):
        return obj.get_full_name().strip()

    def get_profile_picture_url(self, obj):
        return build_media_url(self.context.get('request'), obj.profile_picture)

    def get_is_online(self, obj):
        return is_user_online(obj)

    def get_has_security_question(self, obj):
        return bool(obj.security_question and obj.security_answer_hash)

    def validate_phone_number(self, value):
        cleaned = ''.join(char for char in str(value or '') if char.isdigit())
        if value and (len(cleaned) < 10 or len(cleaned) > 15):
            raise serializers.ValidationError('Enter a valid phone number.')
        return str(value or '').strip()

class ItemSerializer(serializers.ModelSerializer):
    owner_email = serializers.ReadOnlyField(source='owner.email')
    owner_display_name = serializers.SerializerMethodField()
    owner_profile_picture_url = serializers.SerializerMethodField()

    class Meta:
        model = Item
        fields = [
            'id',
            'title',
            'description',
            'type',
            'category',
            'price',
            'image',
            'owner',
            'owner_email',
            'owner_display_name',
            'owner_profile_picture_url',
            'created_at',
            'updated_at',
        ]
        read_only_fields = ['owner']

    def get_owner_display_name(self, obj):
        full_name = obj.owner.get_full_name().strip()
        return full_name or obj.owner.email.split('@')[0]

    def get_owner_profile_picture_url(self, obj):
        return build_media_url(self.context.get('request'), obj.owner.profile_picture)

    def validate_price(self, value):
        if value in [None, '']:
            return None
        return value

class MessageSerializer(serializers.ModelSerializer):
    sender_email = serializers.ReadOnlyField(source='sender.email')
    receiver_email = serializers.ReadOnlyField(source='receiver.email')
    reply_to_id = serializers.PrimaryKeyRelatedField(queryset=Message.objects.all(), source='reply_to', required=False, allow_null=True, write_only=True)
    forwarded_from_id = serializers.PrimaryKeyRelatedField(queryset=Message.objects.all(), source='forwarded_from', required=False, allow_null=True, write_only=True)
    sender_display_name = serializers.SerializerMethodField()
    receiver_display_name = serializers.SerializerMethodField()
    sender_profile_picture_url = serializers.SerializerMethodField()
    receiver_profile_picture_url = serializers.SerializerMethodField()
    sender_is_online = serializers.SerializerMethodField()
    receiver_is_online = serializers.SerializerMethodField()
    sender_last_seen_at = serializers.DateTimeField(source='sender.last_seen_at', read_only=True)
    receiver_last_seen_at = serializers.DateTimeField(source='receiver.last_seen_at', read_only=True)
    attachment_url = serializers.SerializerMethodField()
    attachment_name = serializers.SerializerMethodField()
    attachment_is_image = serializers.SerializerMethodField()
    reply_preview = serializers.SerializerMethodField()
    forwarded_preview = serializers.SerializerMethodField()
    status = serializers.SerializerMethodField()
    display_content = serializers.SerializerMethodField()
    can_delete_for_everyone = serializers.SerializerMethodField()

    class Meta:
        model = Message
        fields = [
            'id',
            'sender',
            'sender_email',
            'sender_display_name',
            'sender_profile_picture_url',
            'sender_is_online',
            'sender_last_seen_at',
            'receiver',
            'receiver_email',
            'receiver_display_name',
            'receiver_profile_picture_url',
            'receiver_is_online',
            'receiver_last_seen_at',
            'content',
            'attachment',
            'attachment_url',
            'attachment_name',
            'attachment_is_image',
            'reply_to_id',
            'reply_preview',
            'forwarded_from_id',
            'forwarded_preview',
            'display_content',
            'status',
            'delivered_at',
            'seen_at',
            'deleted_for_everyone',
            'deleted_at',
            'can_delete_for_everyone',
            'timestamp',
        ]
        read_only_fields = ['sender']

    def validate(self, attrs):
        content = str(attrs.get('content') or '').strip()
        attachment = attrs.get('attachment')
        if not content and not attachment:
            raise serializers.ValidationError({'content': 'Enter a message or attach a file.'})
        return attrs

    def get_display_content(self, obj):
        if obj.deleted_for_everyone:
            return 'This message was deleted.'
        return obj.content

    def get_sender_display_name(self, obj):
        full_name = obj.sender.get_full_name().strip()
        return full_name or obj.sender.email.split('@')[0]

    def get_receiver_display_name(self, obj):
        full_name = obj.receiver.get_full_name().strip()
        return full_name or obj.receiver.email.split('@')[0]

    def get_sender_profile_picture_url(self, obj):
        return build_media_url(self.context.get('request'), obj.sender.profile_picture)

    def get_receiver_profile_picture_url(self, obj):
        return build_media_url(self.context.get('request'), obj.receiver.profile_picture)

    def get_sender_is_online(self, obj):
        return is_user_online(obj.sender)

    def get_receiver_is_online(self, obj):
        return is_user_online(obj.receiver)

    def get_attachment_url(self, obj):
        return build_media_url(self.context.get('request'), obj.attachment)

    def get_attachment_name(self, obj):
        return obj.attachment.name.split('/')[-1] if obj.attachment else ''

    def get_attachment_is_image(self, obj):
        if not obj.attachment:
            return False
        name = obj.attachment.name.lower()
        return name.endswith(('.png', '.jpg', '.jpeg', '.gif', '.webp'))

    def serialize_preview(self, message):
        if not message:
            return None
        sender_name = message.sender.get_full_name().strip() or message.sender.email.split('@')[0]
        display_content = 'This message was deleted.' if message.deleted_for_everyone else (message.content or '')
        attachment_name = message.attachment.name.split('/')[-1] if message.attachment else ''
        return {
            'id': message.id,
            'sender_id': message.sender_id,
            'sender_display_name': sender_name,
            'content': display_content,
            'attachment_name': attachment_name,
        }

    def get_reply_preview(self, obj):
        return self.serialize_preview(obj.reply_to)

    def get_forwarded_preview(self, obj):
        return self.serialize_preview(obj.forwarded_from)

    def get_status(self, obj):
        if obj.seen_at:
            return 'seen'
        if obj.delivered_at:
            return 'delivered'
        return 'sent'

    def get_can_delete_for_everyone(self, obj):
        request = self.context.get('request')
        return bool(request and request.user.is_authenticated and request.user.id == obj.sender_id and not obj.deleted_for_everyone)
