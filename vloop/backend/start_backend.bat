@echo off
setlocal

cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    echo Backend virtual environment not found at .venv\Scripts\python.exe
    echo Create it with:
    echo   python -m venv .venv
    echo   .\.venv\Scripts\python.exe -m pip install -r requirements.txt
    exit /b 1
)

echo Starting V-Loop backend on http://127.0.0.1:8000
".venv\Scripts\python.exe" manage.py runserver 127.0.0.1:8000 --noreload
