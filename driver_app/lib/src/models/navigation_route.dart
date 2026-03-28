import 'package:latlong2/latlong.dart';

class NavigationRoute {
  const NavigationRoute({
    required this.path,
    required this.distanceMeters,
    required this.durationSeconds,
    required this.instructions,
  });

  final List<LatLng> path;
  final int distanceMeters;
  final int durationSeconds;
  final List<String> instructions;

  int get distanceKm => (distanceMeters / 1000).round();

  int get etaMinutes => (durationSeconds / 60).round();
}
