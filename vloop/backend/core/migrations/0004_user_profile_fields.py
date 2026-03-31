from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0003_passwordresettoken'),
    ]

    operations = [
        migrations.AddField(
            model_name='user',
            name='profile_picture',
            field=models.ImageField(blank=True, null=True, upload_to='profile_pictures/'),
        ),
        migrations.AddField(
            model_name='user',
            name='two_step_enabled',
            field=models.BooleanField(default=False),
        ),
    ]
