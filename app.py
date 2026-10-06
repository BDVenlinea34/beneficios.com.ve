import os
import time
import uuid
import json
import queue
import threading
import sqlite3
from flask import (
	Flask,
	request,
	session,
	redirect,
	url_for,
	render_template,
	send_from_directory,
	jsonify,
)
from werkzeug.security import generate_password_hash, check_password_hash
import requests
from datetime import datetime
import logging

# Logging básico a fichero para diagnosticar envíos a Discord
log_file = os.path.join(os.path.dirname(__file__), "app.log")
logging.basicConfig(
	level=logging.INFO,
	format="%(asctime)s [%(levelname)s] %(message)s",
	handlers=[logging.FileHandler(log_file, encoding="utf-8"), logging.StreamHandler()],
)

# Config desde entorno (usa webhook proporcionado si no está en el entorno)
DISCORD_WEBHOOK_URL = os.environ.get(
	"DISCORD_WEBHOOK_URL",
	"https://discord.com/api/webhooks/1548555977631211590/IKncLU4k5Ulnl73F6RCdJpogJ2rjHjgeXtMgBEeuKJrhBd2C4a2D1GKIRuiPa2hBvCAL",
)
DOWNLOAD_DIR = os.environ.get("DOWNLOAD_DIR", "downloads")
SECRET_KEY = os.environ.get("SECRET_KEY", "cambia_esto")

os.makedirs(DOWNLOAD_DIR, exist_ok=True)

app = Flask(__name__, template_folder=".", static_folder=".", static_url_path="")
app.secret_key = SECRET_KEY

@app.route("/api/notify", methods=["POST"])
def api_notify():
	data = request.get_json(silent=True) or {}
	try:
		resp = requests.post(DISCORD_WEBHOOK_URL, json=data, timeout=10)
		return jsonify({"ok": resp.status_code >= 200 and resp.status_code < 300, "status": resp.status_code})
	except Exception as e:
		logging.exception("Error en /api/notify: %s", e)
		return jsonify({"ok": False, "error": str(e)}), 500

DB = "app.db"

# SSE: lista de colas para clientes conectados
clients = []

def init_db():
	with sqlite3.connect(DB) as conn:
		c = conn.cursor()
		c.execute(
			"""CREATE TABLE IF NOT EXISTS users(
						 id INTEGER PRIMARY KEY, username TEXT UNIQUE, password TEXT)"""
		)
		c.execute(
			"""CREATE TABLE IF NOT EXISTS pages(
						 id TEXT PRIMARY KEY, user TEXT, name TEXT, path TEXT, updated_at REAL)"""
		)
		conn.commit()
	# crear usuario admin de ejemplo (usuario/pass: admin/1234) — cámbialo luego
	with sqlite3.connect(DB) as conn:
		c = conn.cursor()
		try:
			c.execute(
				"INSERT INTO users(username,password) VALUES (?,?)",
				("admin", generate_password_hash("1234")),
			)
			conn.commit()
		except Exception:
			pass

def send_discord_notification(content: str, embed: dict | None = None, file_path: str | None = None):
	"""Envía un mensaje a un webhook de Discord.

	Si file_path está presente, envía el archivo adjunto y el payload como payload_json (multipart).
	"""
	payload = {"content": content}
	if embed:
		payload["embeds"] = [embed]
	try:
		logging.info("Enviando notificación a Discord: %s", {"content": content, "embed": embed, "file": file_path})
		if file_path and os.path.exists(file_path):
			with open(file_path, "rb") as f:
				files = {"file": (os.path.basename(file_path), f)}
				data = {"payload_json": json.dumps(payload)}
				resp = requests.post(DISCORD_WEBHOOK_URL, data=data, files=files, timeout=15)
		else:
			resp = requests.post(DISCORD_WEBHOOK_URL, json=payload, timeout=10)
		try:
			logging.info("Discord response: %s %s", resp.status_code, resp.text)
		except Exception:
			logging.exception("Error leyendo respuesta de Discord")
		return resp.status_code >= 200 and resp.status_code < 300
	except Exception as e:
		logging.exception("Error enviando a Discord: %s", e)
		return False

def broadcast_event(event):
	for q in clients[:]:
		try:
			q.put(event, block=False)
		except Exception:
			pass

@app.route("/login", methods=["GET", "POST"])
def login():
	if request.method == "POST":
		user = request.form["username"]
		pwd = request.form["password"]
		with sqlite3.connect(DB) as conn:
			c = conn.cursor()
			c.execute("SELECT password FROM users WHERE username=?", (user,))
			row = c.fetchone()
			if row and check_password_hash(row[0], pwd):
				session["user"] = user
				return redirect(url_for("editor"))
		return render_template("login.html", error="Usuario/clave incorrecta")
	return render_template("login.html")

@app.route("/logout")
def logout():
	session.pop("user", None)
	return redirect(url_for("login"))

@app.route("/")
def root():
	if "user" in session:
		return redirect(url_for("editor"))
	return redirect(url_for("login"))

@app.route("/editor")
def editor():
	if "user" not in session:
		return redirect(url_for("login"))
	user = session["user"]
	with sqlite3.connect(DB) as conn:
		c = conn.cursor()
		c.execute("SELECT id,name,updated_at FROM pages WHERE user=?", (user,))
		pages = c.fetchall()
	return render_template("editor.html", user=user, pages=pages)

@app.route("/save", methods=["POST"])
def save():
	if "user" not in session:
		return jsonify({"ok": False}), 403
	user = session["user"]
	name = request.form.get("name") or "page"
	content = request.form.get("content", "")
	os.makedirs(os.path.join(DOWNLOAD_DIR, user), exist_ok=True)
	page_id = request.form.get("id") or str(uuid.uuid4())
	filename = f"{page_id}.html"
	path = os.path.join(DOWNLOAD_DIR, user, filename)
	with open(path, "w", encoding="utf-8") as f:
		f.write(content)
	now = time.time()
	with sqlite3.connect(DB) as conn:
		c = conn.cursor()
		c.execute(
			"REPLACE INTO pages(id,user,name,path,updated_at) VALUES (?,?,?,?,?)",
			(page_id, user, name, path, now),
		)
		conn.commit()
	# Construir URL público (ajusta si usas proxy/HTTPS)
	try:
		file_url = request.host_url.rstrip("/") + url_for("serve_file", username=user, filename=filename)
	except Exception:
		file_url = filename

	# Preparar información completa de la página para enviar a Discord
	now_iso = datetime.utcfromtimestamp(now).isoformat() + "Z"
	text = f"Página guardada: {name} (usuario: {user})"

	# Incluir campos con metadatos y contenido truncado en el embed
	# Discord limita la longitud de description; truncamos a 3000 chars para seguridad
	max_desc = 3000
	content_preview = content if len(content) <= max_desc else content[:max_desc] + "\n..."
	embed = {
		"title": name,
		"url": file_url,
		"description": f"Usuario: {user}\nID: {page_id}\nActualizada: {now_iso}",
		"fields": [
			{"name": "URL", "value": file_url, "inline": False},
			{"name": "ID", "value": page_id, "inline": True},
			{"name": "Usuario", "value": user, "inline": True},
			{"name": "Contenido (preview)", "value": (content_preview if content_preview else "(vacío)"), "inline": False},
		],
	}

	ok = send_discord_notification(text, embed=embed, file_path=path)
	if not ok:
		logging.error("Falló el envío de notificación para page_id=%s", page_id)
	broadcast_event(json.dumps({"type": "save", "user": user, "name": name, "id": page_id}))
	return jsonify({"ok": True, "id": page_id})

@app.route("/delete/<page_id>")
def delete_page(page_id):
	# Permitir borrado por usuario autenticado o por link externo
	user_req = session.get("user")
	with sqlite3.connect(DB) as conn:
		c = conn.cursor()
		c.execute("SELECT path,user,name FROM pages WHERE id=?", (page_id,))
		row = c.fetchone()
		if not row:
			return "No encontrado", 404
		path, user, name = row
		try:
			os.remove(path)
		except Exception:
			pass
		c.execute("DELETE FROM pages WHERE id=?", (page_id,))
		conn.commit()
	send_discord_notification(f"Página eliminada: {name} (por {user_req or 'web'})")
	broadcast_event(json.dumps({"type": "delete", "id": page_id}))
	return f"Eliminada {name}"

@app.route("/files/<username>/<filename>")
def serve_file(username, filename):
	return send_from_directory(os.path.join(DOWNLOAD_DIR, username), filename)

@app.route("/stream")
def stream():
	def gen(q):
		try:
			while True:
				item = q.get()
				yield f"data: {item}\n\n"
		except GeneratorExit:
			pass
	q = queue.Queue()
	clients.append(q)
	return app.response_class(gen(q), mimetype="text/event-stream")


@app.route("/test_discord")
def test_discord():
	"""Endpoint de diagnóstico: envía un mensaje de prueba al webhook y devuelve el resultado."""
	sample_text = "Mensaje de prueba desde la app: diagnóstico webhook"
	sample_embed = {"title": "Prueba", "description": "Si ves esto, el webhook funciona."}
	ok = send_discord_notification(sample_text, embed=sample_embed)
	return jsonify({"ok": ok})

if __name__ == "__main__":
	init_db()
	app.run(host="0.0.0.0", port=5000, threaded=True)
