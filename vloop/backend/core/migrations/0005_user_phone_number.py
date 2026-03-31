from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0004_user_profile_fields'),
    ]

    operations = [
        migrations.AddField(
            model_name='user',
            name='phone_number',
            field=models.CharField(blank=True, default='', max_length=20),
        ),
    ]
