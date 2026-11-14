"""
Přihlášení: dvě úrovně jako u průmyslových řídicích systémů.
  operator - obsluha stroje (Běh, Jog, Nástroje, Soubory, čtení diagnostiky)
  admin    - navíc Nastavení stroje, testy výstupů/motorů, aktualizace

Heslo obsluhy je volitelné (prázdné = obsluha bez přihlášení), heslo správce
se nastaví při prvním spuštění.
"""

import hashlib
import hmac
import json
import os
import secrets
import threading
import time

SESSION_TTL_S = 12 * 3600
ROLES = {"operator": 1, "admin": 2}


class Auth:
    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.sessions = {}
        self.data = {}
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                self.data = json.load(f)

    def _save(self):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.data, f)
        os.replace(tmp, self.path)
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass

    @staticmethod
    def _hash(password, salt=None):
        salt = salt or secrets.token_hex(16)
        h = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), 200000).hex()
        return {"salt": salt, "hash": h}

    def needs_setup(self):
        return "admin" not in self.data

    def operator_required(self):
        return bool(self.data.get("operator"))

    def set_passwords(self, admin=None, operator=None):
        with self.lock:
            if admin is not None:
                if len(admin) < 4:
                    raise ValueError("Heslo správce musí mít alespoň 4 znaky.")
                self.data["admin"] = self._hash(admin)
            if operator is not None:
                self.data["operator"] = self._hash(operator) if operator else None
            self._save()
            # změna hesel odhlásí všechny
            self.sessions.clear()

    def login(self, role, password):
        if role not in ROLES:
            return None
        rec = self.data.get(role)
        if role == "operator" and not rec:
            ok = True
        elif not rec:
            ok = False
        else:
            ok = hmac.compare_digest(self._hash(password, rec["salt"])["hash"], rec["hash"])
        if not ok:
            time.sleep(0.5)        # zpomalit hádání hesla
            return None
        token = secrets.token_urlsafe(24)
        with self.lock:
            self.sessions[token] = {"role": role, "exp": time.time() + SESSION_TTL_S}
        return token

    def logout(self, token):
        with self.lock:
            self.sessions.pop(token, None)

    def role(self, token):
        """Role pro daný token. Bez přihlášení je obsluha, pokud nemá heslo."""
        with self.lock:
            s = self.sessions.get(token or "")
            if s and s["exp"] > time.time():
                return s["role"]
            if s:
                self.sessions.pop(token, None)
        if not self.needs_setup() and not self.operator_required():
            return "operator"
        return None

    @staticmethod
    def allows(role, needed):
        return role is not None and ROLES[role] >= ROLES[needed]
