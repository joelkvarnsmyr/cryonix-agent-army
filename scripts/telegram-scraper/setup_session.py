"""
One-time session setup for Telegram user client.

Run locally (NOT in Docker):
    python setup_session.py

1. Enter your API ID and API Hash from https://my.telegram.org
2. Enter your phone number
3. Enter the code sent to your Telegram app
4. Enter 2FA password if enabled
5. Copy the printed TELEGRAM_SESSION string to your .env file
"""

import asyncio
import os
from telethon import TelegramClient
from telethon.sessions import StringSession

API_ID = os.getenv('TELEGRAM_API_ID') or input('Enter API ID: ').strip()
API_HASH = os.getenv('TELEGRAM_API_HASH') or input('Enter API Hash: ').strip()


async def main():
    client = TelegramClient(StringSession(), int(API_ID), API_HASH)
    await client.start()

    session_string = client.session.save()
    print('\n' + '=' * 60)
    print('Session created successfully!')
    print('=' * 60)
    print(f'\nTELEGRAM_SESSION={session_string}')
    print('\nAdd this to your .env file on the VM.')
    print('=' * 60)

    await client.disconnect()


if __name__ == '__main__':
    asyncio.run(main())
