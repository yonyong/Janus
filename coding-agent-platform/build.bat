@echo off
rem Build frontend then start backend (production-style, single process on :8000).
call "%~dp0manage.bat" build
