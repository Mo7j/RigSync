class TelemetrySnapshot {
  const TelemetrySnapshot({
    required this.latitude,
    required this.longitude,
    required this.speedKph,
    required this.recordedAt,
  });

  final double latitude;
  final double longitude;
  final double speedKph;
  final DateTime recordedAt;
}
