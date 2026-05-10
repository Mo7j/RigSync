# RigSync

**RigSync** is a digital-twin style operations platform for planning, simulating, and executing land rig moves.
It connects **planning data, fleet allocation, route visibility, move execution, and driver workflows** in one system instead of spreading them across spreadsheets, calls, and disconnected tracking tools.

Built as a senior project, RigSync was designed to feel closer to a real operations product than a classroom prototype: multi-role workflows, live state handling, route simulation, fleet constraints, execution progress, and a separate driver application.

## Why This Project Stands Out

- Solves a real operational problem: rig moves are expensive, multi-stage, and coordination-heavy.
- Combines **planning + execution** instead of stopping at static scheduling.
- Supports **three user roles** with different views: Manager, Foreman, and Driver.
- Uses a hybrid data model:
  - **SQLite** for planning dataset tables
  - **Firebase / Firestore** for live users, moves, assignments, and operational state
- Includes both a **web control platform** and a **Flutter driver app**.
- Models actual field concerns such as truck compatibility, crew requirements, dependencies, route phases, and progress tracking.

## Core Product Capabilities

### 1. Rig Move Planning
- Import a structured planning dataset from Excel into SQLite.
- Build move plans from rig loads, startup loads, truck specs, and dependency chains.
- Compare scenario plans based on time, cost, and utilization trade-offs.
- Validate truck/load compatibility before execution.

### 2. Operational Execution
- Move from planning mode into active execution on the same record.
- Track progress across the full move lifecycle:
  - `Rig Down`
  - `Rig Move`
  - `Rig Up`
- Persist move state, completion percentage, timelines, and execution milestones.

### 3. Management Command Center
- View the network from a manager perspective.
- Monitor active, planned, and drilling rigs.
- Track truck usage, driver readiness, foreman activity, and assignment load.
- Inspect rigs in **2D map** and **3D scene** views.

### 4. Foreman Workflow
- Create and manage rig moves.
- Select plans before execution starts.
- Review load schedules, operating state, and live progress.
- Update rig inventory adjustments tied to the assigned rig.

### 5. Driver Experience
- Separate Flutter app for field-facing task execution.
- Driver login, assigned tasks, route context, and stage completion flow.
- Uses OpenStreetMap/CARTO tiles and OSRM routing for a no-Google-Maps prototype stack.

### 6. Live Operational Data Model
- Firebase Authentication for role-based sign-in.
- Firestore collections for:
  - users
  - moves
  - driver assignments
  - execution events
  - rig inventory

## Architecture

```text
RigSync
|
+-- frontend/      Web application for Manager, Foreman, and Driver dashboards
+-- backend/       Flask API, dataset import, persistence, planning data access
+-- driver_app/    Flutter driver-facing application
+-- docs/          Operational schema and supporting documentation
```

### Web Platform
- Vanilla JavaScript app with modular components and page-level flows
- Manager dashboard, foreman dashboard, move workspace, reports, login, and landing page
- Leaflet-based map views and 3D operational scenes
- English / Arabic language support

### Backend
- Flask API serving both data endpoints and the frontend bundle
- SQLAlchemy models for planning and app state
- Dataset importer from Excel into SQLite
- Endpoints for moves, loads, truck specs, manager resources, and rig inventory

### Mobile App
- Flutter app for drivers
- Local / live repository layers
- Task state, assignment detail, navigation, and flag submission screens

## Tech Stack

### Frontend
- JavaScript
- Modular component architecture
- Leaflet
- Firebase Web SDK
- Custom routing and state flow

### Backend
- Python
- Flask
- SQLAlchemy
- SQLite
- Pandas / OpenPyXL

### Mobile
- Flutter
- Dart

### External Services
- Firebase Authentication
- Cloud Firestore
- OpenStreetMap
- CARTO tiles
- OSRM routing

## Data Model Strategy

RigSync intentionally separates **planning data** from **live operations data**.

### SQLite stores planning datasets
- `load_templates`
- `load_dependencies`
- `load_allowed_truck_types`
- `load_role_requirements`
- `truck_specs`

### Firestore stores live operational state
- user accounts
- active moves
- driver assignments
- execution progress
- rig inventory updates

This split keeps planning deterministic while allowing live operational state to update in real time.

## What Recruiters Should Notice

- This project is not just CRUD. It deals with **simulation, resource allocation, multi-role workflows, and stateful operations**.
- The codebase spans **web, backend, and mobile**, which demonstrates full-stack ownership.
- It handles both **domain modeling** and **product experience**:
  - operations constraints
  - route planning
  - execution state transitions
  - dashboard UX
  - mobile field workflows
- The project is organized around a believable real-world use case rather than generic demo features.

## Local Setup

### 1. Install Python dependencies

```powershell
python -m pip install -r requirements.txt
```

### 2. Import the planning dataset

```powershell
python backend/import_dataset.py
```

By default, the importer prefers the latest ISE workbook at:

```text
~/Downloads/ise/ise_data_final_v2.xlsx
```

If you want to use a different workbook, set `RIGSYNC_DATASET_PATH` first:

```powershell
$env:RIGSYNC_DATASET_PATH="C:\path\to\your\workbook.xlsx"
python backend/import_dataset.py
```

### 3. Run the web platform

```powershell
python backend/app.py
```

Then open:

```text
http://127.0.0.1:5000
```

## Driver App Setup

From `driver_app/`:

```bash
flutter pub get
flutter run
```

Demo driver credentials currently used in the app:

- Email: `driver@rigsync.com`
- Password: `123456`

## Key Repository Areas

- [backend/app.py](backend/app.py)  
  Main Flask application, API routes, move persistence, and frontend serving

- [backend/import_dataset.py](backend/import_dataset.py)  
  Imports and validates the planning dataset into SQLite

- [frontend/main.js](frontend/main.js)  
  Main application entry point and role-based app flow

- [frontend/pages/RigMovePage.js](frontend/pages/RigMovePage.js)  
  Core move planning and execution workspace

- [frontend/pages/ManagerDashboardPage.js](frontend/pages/ManagerDashboardPage.js)  
  Manager command center and fleet oversight

- [docs/firebase-operational-schema.md](docs/firebase-operational-schema.md)  
  Firestore structure for live operational data

- [driver_app/lib/main.dart](driver_app/lib/main.dart)  
  Flutter driver application entry point

## Current Scope

Implemented well enough to demonstrate product direction:
- planning dataset import
- move creation and plan comparison
- execution state tracking
- manager / foreman / driver role flows
- Firebase-backed live operational model
- separate driver mobile experience

Still prototype-level in some areas:
- production hardening
- deployment packaging
- automated tests across the whole system
- full backend integration for every mobile flow

## Project Vision

RigSync aims to show what a modern rig-move coordination platform could look like if planning, live execution, and field operations were built as one connected system.

Instead of treating logistics, dashboarding, and mobile coordination as separate tools, RigSync treats them as parts of the same operational digital twin.

## Author Note

This repository is being presented as a portfolio-quality systems project. The focus was not only on building features, but on modeling a realistic industrial workflow with role-based coordination, operational data, and execution visibility across web and mobile surfaces.
