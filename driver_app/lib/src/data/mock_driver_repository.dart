import '../models/driver_task.dart';
import '../models/route_checkpoint.dart';
import '../models/task_location.dart';

class LoginResult {
  const LoginResult({
    required this.driverName,
  });

  final String driverName;
}

class MockDriverRepository {
  static const String _demoEmail = 'driver@rigsync.com';
  static const String _demoPassword = '123456';

  Future<LoginResult> login({
    required String email,
    required String password,
  }) async {
    await Future<void>.delayed(const Duration(milliseconds: 700));

    if (email.trim().toLowerCase() != _demoEmail || password != _demoPassword) {
      throw Exception('Invalid driver credentials.');
    }

    return const LoginResult(driverName: 'Faisal Al-Harbi');
  }

  Future<List<DriverTask>> fetchAssignedTasks() async {
    await Future<void>.delayed(const Duration(milliseconds: 350));

    return <DriverTask>[
      DriverTask(
        id: 'task-101',
        title: 'Rig Transfer A17',
        assetName: 'Drill Mast + Support Units',
        origin: const TaskLocation(
          label: 'Abqaiq Yard',
          latitude: 25.9341,
          longitude: 49.6688,
        ),
        destination: const TaskLocation(
          label: 'Rig Site 12B',
          latitude: 25.7712,
          longitude: 49.4312,
        ),
        scheduledWindow: 'Today | 14:30',
        status: DriverTaskStatus.ready,
        etaMinutes: 88,
        totalDistanceKm: 134,
        routePoints: const <RouteCheckpoint>[
          RouteCheckpoint(x: 0.08, y: 0.80, label: 'Yard Exit', speedKph: 0),
          RouteCheckpoint(x: 0.18, y: 0.72, label: 'Service Road', speedKph: 25),
          RouteCheckpoint(x: 0.34, y: 0.67, label: 'Highway Merge', speedKph: 58),
          RouteCheckpoint(x: 0.50, y: 0.55, label: 'Checkpoint A', speedKph: 63),
          RouteCheckpoint(x: 0.68, y: 0.43, label: 'Desert Corridor', speedKph: 67),
          RouteCheckpoint(x: 0.82, y: 0.33, label: 'Rig Access Turn', speedKph: 36),
          RouteCheckpoint(x: 0.91, y: 0.24, label: 'Rig Site 12B', speedKph: 0),
        ],
        instructions: const <String>[
          'Exit the yard and hold in lane 2 toward Highway 95.',
          'Maintain convoy spacing through Checkpoint A.',
          'Reduce speed before the access road and await site clearance.',
        ],
      ),
      DriverTask(
        id: 'task-204',
        title: 'Mud Pump Delivery',
        assetName: 'Mud Pump Trailer',
        origin: const TaskLocation(
          label: 'Dammam Logistics Hub',
          latitude: 26.4207,
          longitude: 50.0888,
        ),
        destination: const TaskLocation(
          label: 'Rig Site 08C',
          latitude: 26.1501,
          longitude: 49.7680,
        ),
        scheduledWindow: 'Today | 16:10',
        status: DriverTaskStatus.inProgress,
        etaMinutes: 42,
        totalDistanceKm: 61,
        routePoints: const <RouteCheckpoint>[
          RouteCheckpoint(x: 0.11, y: 0.83, label: 'Hub Gate', speedKph: 0),
          RouteCheckpoint(x: 0.23, y: 0.74, label: 'North Connector', speedKph: 33),
          RouteCheckpoint(x: 0.39, y: 0.62, label: 'Route 40', speedKph: 64),
          RouteCheckpoint(x: 0.58, y: 0.48, label: 'Fuel Stop Pass', speedKph: 62),
          RouteCheckpoint(x: 0.74, y: 0.34, label: 'Camp Junction', speedKph: 41),
          RouteCheckpoint(x: 0.88, y: 0.19, label: 'Rig Site 08C', speedKph: 0),
        ],
        instructions: const <String>[
          'Stay on Route 40 for 28 km.',
          'Bypass fuel stop and continue to Camp Junction.',
          'Use escort lane on final approach to site.',
        ],
      ),
      DriverTask(
        id: 'task-331',
        title: 'Generator Pickup',
        assetName: 'Twin Generator Set',
        origin: const TaskLocation(
          label: 'Khobar Equipment Park',
          latitude: 26.2172,
          longitude: 50.1971,
        ),
        destination: const TaskLocation(
          label: 'Warehouse Return Bay',
          latitude: 26.1457,
          longitude: 50.0021,
        ),
        scheduledWindow: 'Tomorrow | 08:00',
        status: DriverTaskStatus.pending,
        etaMinutes: 54,
        totalDistanceKm: 47,
        routePoints: const <RouteCheckpoint>[
          RouteCheckpoint(x: 0.10, y: 0.76, label: 'Equipment Park', speedKph: 0),
          RouteCheckpoint(x: 0.30, y: 0.68, label: 'Industrial Ring', speedKph: 38),
          RouteCheckpoint(x: 0.45, y: 0.53, label: 'Transit Lane', speedKph: 52),
          RouteCheckpoint(x: 0.69, y: 0.37, label: 'West Logistics Road', speedKph: 49),
          RouteCheckpoint(x: 0.86, y: 0.24, label: 'Return Bay', speedKph: 0),
        ],
        instructions: const <String>[
          'Wait for dispatch release before departure.',
          'Use industrial ring route due to axle load restrictions.',
          'Confirm return-bay dock slot on arrival.',
        ],
      ),
    ];
  }
}
