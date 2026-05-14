# 🏢 Local Queue Management System

> LAN-based queue system for **DMW** and **OWWA** with real-time serving board, kiosk intake, officer dashboards, and admin panel.

---

## ⚡ Quick Start (3 Steps)

### Step 1 — Install Node.js

Download and install **Node.js** (LTS version) from:

👉 **https://nodejs.org**

During installation, just click **Next → Next → Finish** (use all defaults).

> **Note:** You do **NOT** need VS Code or any code editor. Just Node.js.

### Step 2 — Install Dependencies

1. Open the `local-queue-system` folder in **File Explorer**
2. Click on the **address bar** at the top and type `cmd`, then press **Enter**
   — this opens Command Prompt directly inside the folder
3. In the Command Prompt window, type:

```
npm install
```

> This downloads the required libraries into the `node_modules` folder. You only need to do this **once**.

### Step 3 — Start the Server

In the same Command Prompt window, run:

```
npm start
```

You should see output like:

```
Connected to the SQLite database.
Server running at http://localhost:3000
Other PCs on the same WiFi connect via http://192.168.x.x:3000
```

✅ **That's it! The system is now running.**

---

## 🌐 How to Access the Pages

Open **Google Chrome** (or any browser) and go to:

| Page              | URL                                       | Purpose                              |
| ----------------- | ----------------------------------------- | ------------------------------------ |
| **Kiosk**         | `http://localhost:3000/kiosk.html`        | Client self-service ticket intake    |
| **Serving Board** | `http://localhost:3000/serving-board.html` | Public display of now-serving queue  |
| **DMW Officer**   | `http://localhost:3000/dmw.html`          | DMW officer dashboard                |
| **OWWA Officer**  | `http://localhost:3000/owwa.html`         | OWWA officer dashboard               |
| **Admin Panel**   | `http://localhost:3000/admin.html`        | System admin overview & controls     |
| **History**       | `http://localhost:3000/history.html`      | Past records & export                |

### Accessing from Other Computers (LAN)

If other computers are connected to the **same WiFi/network**, they can access the system by replacing `localhost` with the **IP address** shown in the terminal.

Example: `http://192.168.1.100:3000/kiosk.html`

---

## 🔑 Default Login Accounts

| Role        | Username | Password   |
| ----------- | -------- | ---------- |
| **Admin**   | admin1   | admin123   |
| **Admin**   | admin2   | admin123   |
| **Kiosk**   | kiosk1   | kiosk123   |
| **Kiosk**   | kiosk2   | kiosk123   |
| **DMW Officer**  | DMW1 | dmw123     |
| **DMW Officer**  | DMW2 | dmw123     |
| **DMW Officer**  | DMW3 | dmw123     |
| **OWWA Officer** | owwa1 | owwa123   |
| **OWWA Officer** | owwa2 | owwa123   |
| **OWWA Officer** | owwa3 | owwa123   |

---

## 🛑 How to Stop the Server

In the Command Prompt window where the server is running, press:

```
Ctrl + C
```

Then type `Y` and press Enter when prompted.

---

## 🔄 Restarting the Server

If you need to restart (e.g., after a PC reboot), just open the `local-queue-system` folder again, type `cmd` in the address bar, and run:

```
npm start
```

---

## 📁 Project Structure

```
local-queue-system/
├── server.js            ← Main server (handles API + real-time updates)
├── package.json         ← Project configuration & dependencies
├── queue_simple.db      ← SQLite database (auto-created)
├── last_reset.txt       ← Tracks the last daily reset date
├── backups/             ← Automatic daily database backups
└── public/              ← Frontend files (HTML/CSS/JS)
    ├── index.html       ← Landing / login page
    ├── kiosk.html       ← Client kiosk for ticket intake
    ├── serving-board.html ← Public now-serving display
    ├── dmw.html         ← DMW officer dashboard
    ├── owwa.html        ← OWWA officer dashboard
    ├── officer.html     ← General officer login
    ├── admin.html       ← Admin control panel
    ├── history.html     ← Records history & export
    ├── screensaver.html ← Idle screen display
    └── assets/          ← Logos and static assets
```

---

## ❓ Troubleshooting

| Problem | Solution |
| ------- | -------- |
| `'node' is not recognized` | Node.js is not installed. Download it from https://nodejs.org |
| `npm install` fails | Make sure you're inside the `local-queue-system` folder |
| Port 3000 already in use | Close any other app using port 3000, or restart your PC |
| Other PCs can't connect | Make sure all devices are on the **same WiFi network** |
| Database is empty | The database resets daily at midnight. This is by design. |

---

## 💡 Technical Requirements

- **OS:** Windows 10 / 11 (also works on macOS and Linux)
- **Software:** Node.js v18 or later (LTS recommended)
- **Browser:** Google Chrome (recommended), Edge, or Firefox
- **Network:** All devices must be on the same local network (WiFi/LAN) for multi-device access
