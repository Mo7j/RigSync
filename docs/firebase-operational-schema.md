# Firebase Operational Schema

## Purpose

Firebase will own live operational data and accounts:

- manager / foreman / driver accounts
- active moves
- driver task assignments
- execution stage updates
- real-time status events

Local SQLite stays limited to planning dataset tables only:

- `load_templates`
- `load_dependencies`
- `load_allowed_truck_types`
- `load_role_requirements`
- `truck_specs`

## Firestore collections

### `users`

Document id: user uid

Suggested fields:

- `role`: `Manager` | `Foreman` | `Driver`
- `name`
- `email`
- `managerId`
- `truckType`
- `truckId`
- `active`

### `moves`

Document id: move id

Suggested fields:

- `name`
- `managerId`
- `foremanId`
- `executionState`
- `operatingState`
- `startLabel`
- `endLabel`
- `planningStartDate`
- `planningStartTime`
- `routeKm`
- `routeTime`
- `simulationSummary`
- `executionProgress`
- `updatedAt`

### `driverAssignments`

Document id: assignment id

Suggested fields:

- `moveId`
- `managerId`
- `driverId`
- `driverName`
- `truckId`
- `truckType`
- `currentStage`
- `status`
- `stageStatus`
- `startLabel`
- `endLabel`
- `sequence`
- `updatedAt`

### `executionEvents`

Document id: generated id

Suggested fields:

- `moveId`
- `assignmentId`
- `driverId`
- `stage`
- `eventType`
- `createdAt`

### `rigInventory`

Document id: rig id

Suggested fields:

- `adjustments`
- `updatedBy`
- `updatedAt`
