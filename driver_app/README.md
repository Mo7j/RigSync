# RigSync Driver App

Standalone Flutter UI prototype for the driver experience.

Current scope:
- Mock login flow
- Assigned tasks list
- Active task navigation screen
- Real device GPS tracking
- Real map rendering with OpenStreetMap/CARTO tiles
- Route fetching through OSRM

Not connected yet:
- Backend authentication
- Real task API
- Dispatch/location upload API

## Run later

After Flutter is installed:

```bash
flutter pub get
flutter run
```

## Demo credentials

- Email: `driver@rigsync.com`
- Password: `123456`

## Free map stack

This app now uses:
- `flutter_map`
- CARTO dark tiles
- OpenStreetMap data
- OSRM route service

This removes the Google Maps key requirement for the current prototype.
