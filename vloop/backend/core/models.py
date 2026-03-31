from django.db import models
from django.contrib.auth.models import AbstractUser, BaseUserManager
from django.utils import timezone

class UserManager(BaseUserManager):
    def create_user(self, email, password=None, **extra_fields):
        if not email:
            raise ValueError('The Email field must be set')
        email = self.normalize_email(email).strip().lower()
        user = self.model(email=email, **extra_fields)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_superuser(self, email, password=None, **extra_fields):
        extra_fields.setdefault('is_staff', True)
        extra_fields.setdefault('is_superuser', True)

        if extra_fields.get('is_staff') is not True:
            raise ValueError('Superuser must have is_staff=True.')
        if extra_fields.get('is_superuser') is not True:
            raise ValueError('Superuser must have is_superuser=True.')

        return self.create_user(email, password, **extra_fields)

class User(AbstractUser):
    username = None
    email = models.EmailField(unique=True)
    phone_number = models.CharField(max_length=20, blank=True, default='')
    profile_picture = models.ImageField(upload_to='profile_pictures/', null=True, blank=True)
    two_step_enabled = models.BooleanField(default=False)
    security_question = models.CharField(max_length=255, blank=True, default='')
    security_answer_hash = models.CharField(max_length=255, blank=True, default='')
    last_seen_at = models.DateTimeField(null=True, blank=True)

    USERNAME_FIELD = 'email'
    REQUIRED_FIELDS = []

    objects = UserManager()

    def __str__(self):
        return self.email

class Item(models.Model):
    TYPE_CHOICES = [
        ('Sell', 'Sell'),
        ('Lend', 'Lend'),
        ('Request', 'Request')
    ]
    CATEGORY_CHOICES = [
        ('Textbook', 'Textbook'),
        ('Lab Equipment', 'Lab Equipment'),
        ('Project Material', 'Project Material'),
        ('Other', 'Other')
    ]
    
    title = models.CharField(max_length=200)
    description = models.TextField()
    type = models.CharField(max_length=20, choices=TYPE_CHOICES)
    category = models.CharField(max_length=50, choices=CATEGORY_CHOICES)
    price = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    image = models.ImageField(upload_to='item_images/', null=True, blank=True)
    owner = models.ForeignKey(User, on_delete=models.CASCADE, related_name='items')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return self.title

class Message(models.Model):
    sender = models.ForeignKey(User, on_delete=models.CASCADE, related_name='sent_messages')
    receiver = models.ForeignKey(User, on_delete=models.CASCADE, related_name='received_messages')
    content = models.TextField(blank=True, default='')
    attachment = models.FileField(upload_to='message_attachments/', null=True, blank=True)
    reply_to = models.ForeignKey('self', on_delete=models.SET_NULL, null=True, blank=True, related_name='replies')
    forwarded_from = models.ForeignKey('self', on_delete=models.SET_NULL, null=True, blank=True, related_name='forwards')
    timestamp = models.DateTimeField(auto_now_add=True)
    delivered_at = models.DateTimeField(null=True, blank=True)
    seen_at = models.DateTimeField(null=True, blank=True)
    # Messages hidden by a specific user stay in the database for the other participant.
    hidden_for = models.ManyToManyField(User, related_name='hidden_messages', blank=True)
    # Sender-only action that replaces content for both participants.
    deleted_for_everyone = models.BooleanField(default=False)
    deleted_at = models.DateTimeField(null=True, blank=True)
    
    class Meta:
        ordering = ['timestamp']

    def __str__(self):
        return f"{self.sender} to {self.receiver} at {self.timestamp}"


class PasswordResetToken(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='password_reset_tokens')
    token = models.CharField(max_length=64, unique=True)
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    used_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at']

    @property
    def is_active(self):
        return self.used_at is None and self.expires_at > timezone.now()

    def __str__(self):
        return f"Reset token for {self.user.email}"


class LoginOTPChallenge(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='login_otp_challenges')
    token = models.CharField(max_length=64, unique=True)
    code_hash = models.CharField(max_length=128)
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    used_at = models.DateTimeField(null=True, blank=True)
    failed_attempts = models.PositiveSmallIntegerField(default=0)

    class Meta:
        ordering = ['-created_at']

    @property
    def is_active(self):
        return self.used_at is None and self.expires_at > timezone.now()

    def __str__(self):
        return f"Login OTP for {self.user.email}"


class SecurityQuestionChallenge(models.Model):
    PURPOSE_LOGIN = 'login'
    PURPOSE_PASSWORD_CHANGE = 'password_change'
    PURPOSE_DELETE_ACCOUNT = 'delete_account'
    PURPOSE_CHOICES = [
        (PURPOSE_LOGIN, 'Login'),
        (PURPOSE_PASSWORD_CHANGE, 'Password Change'),
        (PURPOSE_DELETE_ACCOUNT, 'Delete Account'),
    ]

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='security_question_challenges')
    token = models.CharField(max_length=64, unique=True)
    purpose = models.CharField(max_length=32, choices=PURPOSE_CHOICES)
    question_snapshot = models.CharField(max_length=255)
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    used_at = models.DateTimeField(null=True, blank=True)
    failed_attempts = models.PositiveSmallIntegerField(default=0)
    locked_until = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at']

    @property
    def is_active(self):
        return self.used_at is None and self.expires_at > timezone.now()

    def __str__(self):
        return f"Security challenge for {self.user.email} ({self.purpose})"


class SecurityVerificationAttempt(models.Model):
    user = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True, related_name='security_verification_attempts')
    challenge = models.ForeignKey(
        SecurityQuestionChallenge,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='attempt_logs',
    )
    purpose = models.CharField(max_length=32, choices=SecurityQuestionChallenge.PURPOSE_CHOICES)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    success = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        status = 'success' if self.success else 'failed'
        return f"{status} security verification for {self.user_id or 'deleted-user'} ({self.purpose})"
