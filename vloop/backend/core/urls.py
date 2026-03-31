from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import (
    register_user,
    login_user,
    verify_security_question,
    forgot_password,
    reset_password,
    password_reset_link,
    password_reset_page,
    profile,
    update_profile_password,
    update_two_step,
    delete_account,
    ItemViewSet,
    MessageViewSet,
)


router = DefaultRouter()
router.register(r'items', ItemViewSet, basename='item')
router.register(r'messages', MessageViewSet, basename='message')

urlpatterns = [
    path('register/', register_user, name='register'),
    path('login/', login_user, name='login'),
    path('login/verify-security-question/', verify_security_question, name='verify_security_question'),
    path('login/verify-otp/', verify_security_question, name='verify_login_otp'),
    path('forgot-password/', forgot_password, name='forgot_password'),
    path('reset-password/', reset_password, name='reset_password'),
    path('password-reset-link/<str:token>/', password_reset_link, name='password_reset_link'),
    path('reset-password-page/', password_reset_page, name='password_reset_page'),
    path('profile/', profile, name='profile'),
    path('profile/password/', update_profile_password, name='profile_password'),
    path('profile/two-step/', update_two_step, name='profile_two_step'),
    path('profile/delete-account/', delete_account, name='profile_delete_account'),
    path('', include(router.urls)),
]
