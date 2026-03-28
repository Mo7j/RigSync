import 'route_checkpoint.dart';
import 'task_location.dart';

enum DriverTaskStatus {
  pending,
  ready,
  inProgress,
}

class DriverTask {
  const DriverTask({
    required this.id,
    required this.title,
    required this.assetName,
    required this.origin,
    required this.destination,
    required this.scheduledWindow,
    required this.status,
    required this.etaMinutes,
    required this.totalDistanceKm,
    required this.routePoints,
    required this.instructions,
  });

  final String id;
  final String title;
  final String assetName;
  final TaskLocation origin;
  final TaskLocation destination;
  final String scheduledWindow;
  final DriverTaskStatus status;
  final int etaMinutes;
  final int totalDistanceKm;
  final List<RouteCheckpoint> routePoints;
  final List<String> instructions;
}
