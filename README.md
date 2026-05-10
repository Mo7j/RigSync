# RigSync

RigSync is a full-stack platform for planning, simulating, and executing land rig moves. It combines planning data, fleet coordination, route visibility, execution tracking, and driver workflows in a single system.

The project includes a web platform for managers and foremen, a Python backend for planning data and operational APIs, and a separate Flutter driver app for field execution.

## Overview

- Plan rig moves from structured load and truck data
- Compare execution scenarios by time, cost, and utilization
- Track progress across rig down, move, and rig up stages
- Manage trucks, drivers, foremen, and rig-level operational state
- Support separate manager, foreman, and driver workflows

## Architecture

```text
frontend/    Web application and dashboards
backend/     Flask API, SQLite models, dataset import
driver_app/  Flutter driver application
docs/        Supporting operational schema docs
```

## Stack

- Frontend: JavaScript, Leaflet, Firebase Web SDK
- Backend: Python, Flask, SQLAlchemy, SQLite
- Mobile: Flutter, Dart
- Services: Firebase Authentication, Firestore, OpenStreetMap, CARTO, OSRM

## Data Model

RigSync separates planning data from live operational data.

- SQLite stores planning tables such as load templates, dependencies, role requirements, and truck specs
- Firestore stores users, active moves, assignments, execution progress, and rig inventory state

## Running Locally

Install Python dependencies:

```powershell
python -m pip install -r requirements.txt
```

Import the planning dataset:

```powershell
python backend/import_dataset.py
```

If needed, point the importer to a different workbook:

```powershell
$env:RIGSYNC_DATASET_PATH="C:\path\to\your\workbook.xlsx"
python backend/import_dataset.py
```

Run the app:

```powershell
python backend/app.py
```

Open `http://127.0.0.1:5000`.

## Driver App

From `driver_app/`:

```bash
flutter pub get
flutter run
```

Demo driver credentials:

- Email: `driver@rigsync.com`
- Password: `123456`

## Key Files

- [backend/app.py](/abs/path/c/Users/7jmo7/Desktop/Github/RigSync/backend/app.py)
- [backend/import_dataset.py](/abs/path/c/Users/7jmo7/Desktop/Github/RigSync/backend/import_dataset.py)
- [frontend/main.js](/abs/path/c/Users/7jmo7/Desktop/Github/RigSync/frontend/main.js)
- [frontend/pages/RigMovePage.js](/abs/path/c/Users/7jmo7/Desktop/Github/RigSync/frontend/pages/RigMovePage.js)
- [frontend/pages/ManagerDashboardPage.js](/abs/path/c/Users/7jmo7/Desktop/Github/RigSync/frontend/pages/ManagerDashboardPage.js)
- [docs/firebase-operational-schema.md](/abs/path/c/Users/7jmo7/Desktop/Github/RigSync/docs/firebase-operational-schema.md)
