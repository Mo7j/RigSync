import 'task_location.dart';

enum AssignmentStage { rigDown, rigMove, rigUp, completed }

enum AssignmentStatus { queued, assigned, accepted, active, paused, completed }

class DriverAssignment {
  const DriverAssignment({
    required this.id,
    required this.moveId,
    required this.moveName,
    required this.tripLabel,
    required this.tripNumber,
    required this.plannedTripCount,
    required this.loadCode,
    required this.startLabel,
    required this.endLabel,
    required this.currentStage,
    required this.status,
    required this.sequence,
    required this.assignedAt,
    required this.updatedAt,
    required this.pickupLocation,
    required this.destinationLocation,
  });

  final String id;
  final String moveId;
  final String moveName;
  final String tripLabel;
  final int tripNumber;
  final int plannedTripCount;
  final String loadCode;
  final String startLabel;
  final String endLabel;
  final AssignmentStage currentStage;
  final AssignmentStatus status;
  final int sequence;
  final DateTime? assignedAt;
  final DateTime? updatedAt;
  final TaskLocation? pickupLocation;
  final TaskLocation? destinationLocation;

  DriverAssignment copyWith({
    String? id,
    String? moveId,
    String? moveName,
    String? tripLabel,
    int? tripNumber,
    int? plannedTripCount,
    String? loadCode,
    String? startLabel,
    String? endLabel,
    AssignmentStage? currentStage,
    AssignmentStatus? status,
    int? sequence,
    DateTime? assignedAt,
    DateTime? updatedAt,
    TaskLocation? pickupLocation,
    TaskLocation? destinationLocation,
  }) {
    return DriverAssignment(
      id: id ?? this.id,
      moveId: moveId ?? this.moveId,
      moveName: moveName ?? this.moveName,
      tripLabel: tripLabel ?? this.tripLabel,
      tripNumber: tripNumber ?? this.tripNumber,
      plannedTripCount: plannedTripCount ?? this.plannedTripCount,
      loadCode: loadCode ?? this.loadCode,
      startLabel: startLabel ?? this.startLabel,
      endLabel: endLabel ?? this.endLabel,
      currentStage: currentStage ?? this.currentStage,
      status: status ?? this.status,
      sequence: sequence ?? this.sequence,
      assignedAt: assignedAt ?? this.assignedAt,
      updatedAt: updatedAt ?? this.updatedAt,
      pickupLocation: pickupLocation ?? this.pickupLocation,
      destinationLocation: destinationLocation ?? this.destinationLocation,
    );
  }

  bool get isCurrent =>
      status == AssignmentStatus.assigned ||
      status == AssignmentStatus.accepted ||
      status == AssignmentStatus.active ||
      status == AssignmentStatus.paused;
  bool get isUpcoming => !isCurrent && status != AssignmentStatus.completed;
}
