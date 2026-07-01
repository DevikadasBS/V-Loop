# V-Loop | Campus Marketplace 🎓♻️

V-Loop is a secure, real-time marketplace exclusively for Vidya Academy students to buy, sell, and lend academic resources.


### 1. Backend Setup
1. Open terminal in `backend/`.
2. Create and activate the virtual environment:
   - Windows: `python -m venv .venv`
   - Windows PowerShell: `.\.venv\Scripts\Activate.ps1`
3. Install dependencies: `python -m pip install -r requirements.txt`
4. Run migrations: `python manage.py migrate`
5. Start the server:
   - Recommended on Windows: double-click `backend/start_backend.bat`
   - Or run `python manage.py runserver 127.0.0.1:8000 --noreload`

### 2. Email Configuration (SMTP)
1. Copy `backend/.env.example` to `backend/.env`.
2. Fill in `EMAIL_HOST_USER` with the app's real sender Gmail address.
3. Fill in `EMAIL_HOST_PASSWORD` with that Gmail account's App Password.
4. Set `DEFAULT_FROM_EMAIL` to the same sender address.
5. Keep `FRONTEND_RESET_URL` pointing at your real `reset-password.html` page.
6. Restart the backend after editing `.env`.
7. If `.env` is not configured, forgot-password will return an error instead of pretending an email was sent.
8. This sender account is only for sending reset mails. Users still create their own accounts and receive reset links in their own email inboxes.

### 3. Frontend Setup
1. Ensure the backend server is running on `127.0.0.1:8000`.
2. Serve the workspace root with `python -m http.server 5500`.
3. Open `http://127.0.0.1:5500/vloop/frontend/index.html` in your browser.
4. Connect and start Looping!

## 🔐 Core Features Implemented
- **Auth:** Signup (@vidyaacademy.ac.in), Login, Logout.
- **Marketplace:** CRUD Items with image uploads (stored in `media/`).
- **Real-time Chat:** Peer-to-peer WebSocket messaging.
- **Password Reset:** Token-based secure reset via Gmail SMTP.

---
*Built with Django, DRF, Channels, and Tailwind CSS.*
