from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0001_initial'),
    ]

    operations = [
        migrations.AddField(
            model_name='message',
            name='deleted_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='message',
            name='deleted_for_everyone',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='message',
            name='hidden_for',
            field=models.ManyToManyField(blank=True, related_name='hidden_messages', to='core.user'),
        ),
    ]
