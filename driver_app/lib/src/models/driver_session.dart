class DriverSession {
  const DriverSession({
    required this.id,
    required this.name,
    required this.email,
    required this.managerId,
    required this.truckType,
    required this.currentStatus,
  });

  final String id;
  final String name;
  final String email;
  final String managerId;
  final String truckType;
  final String currentStatus;

  DriverSession copyWith({
    String? currentStatus,
  }) {
    return DriverSession(
      id: id,
      name: name,
      email: email,
      managerId: managerId,
      truckType: truckType,
      currentStatus: currentStatus ?? this.currentStatus,
    );
  }
}
