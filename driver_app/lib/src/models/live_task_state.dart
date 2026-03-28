import 'dart:math' as math;

import 'driver_task.dart';
import 'route_checkpoint.dart';

class LiveTaskState {
  const LiveTaskState({
    required this.currentPosition,
    required this.nextStop,
    required this.completedStops,
    required this.totalStops,
    required this.speedKph,
    required this.etaMinutes,
    required this.distanceRemainingKm,
    required this.locationSharingEnabled,
    required this.lastSyncLabel,
    required this.progress,
  });

  final RouteCheckpoint currentPosition;
  final RouteCheckpoint nextStop;
  final int completedStops;
  final int totalStops;
  final int speedKph;
  final int etaMinutes;
  final int distanceRemainingKm;
  final bool locationSharingEnabled;
  final String lastSyncLabel;
  final double progress;

  factory LiveTaskState.fromTask({
    required DriverTask task,
    required int tick,
  }) {
    final points = task.routePoints;
    if (points.length == 1) {
      return LiveTaskState(
        currentPosition: points.first,
        nextStop: points.first,
        completedStops: 1,
        totalStops: 1,
        speedKph: points.first.speedKph,
        etaMinutes: 0,
        distanceRemainingKm: 0,
        locationSharingEnabled: true,
        lastSyncLabel: 'Synced just now',
        progress: 1,
      );
    }

    const int ticksPerLeg = 5;
    final int maxTick = (points.length - 1) * ticksPerLeg;
    final int safeTick = tick.clamp(0, maxTick);
    final int legIndex = math.min(safeTick ~/ ticksPerLeg, points.length - 2);
    final double legProgress = (safeTick % ticksPerLeg) / ticksPerLeg;
    final RouteCheckpoint start = points[legIndex];
    final RouteCheckpoint end = points[legIndex + 1];

    final RouteCheckpoint interpolated = RouteCheckpoint(
      x: _lerp(start.x, end.x, legProgress),
      y: _lerp(start.y, end.y, legProgress),
      label: start.label,
      speedKph: _lerp(start.speedKph.toDouble(), end.speedKph.toDouble(), legProgress).round(),
    );

    final double progress = maxTick == 0 ? 1 : safeTick / maxTick;
    final int eta = math.max(4, (task.etaMinutes * (1 - progress)).round());
    final int remainingDistance = math.max(0, (task.totalDistanceKm * (1 - progress)).round());
    final String syncLabel;

    if (safeTick >= maxTick) {
      syncLabel = 'Arrival confirmed';
    } else if (safeTick % 2 == 0) {
      syncLabel = 'GPS updated 8 sec ago';
    } else {
      syncLabel = 'GPS updated 3 sec ago';
    }

    return LiveTaskState(
      currentPosition: safeTick >= maxTick ? points.last : interpolated,
      nextStop: points[math.min(legIndex + 1, points.length - 1)],
      completedStops: math.min(legIndex + (safeTick % ticksPerLeg == 0 ? 0 : 1), points.length - 1),
      totalStops: points.length - 1,
      speedKph: safeTick >= maxTick ? 0 : interpolated.speedKph,
      etaMinutes: safeTick >= maxTick ? 0 : eta,
      distanceRemainingKm: safeTick >= maxTick ? 0 : remainingDistance,
      locationSharingEnabled: true,
      lastSyncLabel: syncLabel,
      progress: progress,
    );
  }

  static double _lerp(double start, double end, double t) {
    return start + ((end - start) * t);
  }
}
