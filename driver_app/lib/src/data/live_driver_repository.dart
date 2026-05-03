import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/driver_task.dart';
import '../models/route_checkpoint.dart';
import '../models/task_location.dart';

const String _firebaseApiKey = 'AIzaSyDPNmHSjioHB6k1vGS2g05SIHQ30Vw54aM';
const String _firebaseProjectId = 'rigsync-38f79';
const double _fallbackLatitude = 25.2854;
const double _fallbackLongitude = 49.5480;

class DriverSession {
  const DriverSession({
    required this.id,
    required this.email,
    required this.driverName,
    required this.managerId,
    required this.idToken,
  });

  final String id;
  final String email;
  final String driverName;
  final String managerId;
  final String idToken;
}

class LoginResult {
  const LoginResult({
    required this.session,
  });

  final DriverSession session;
}

class LiveDriverRepository {
  LiveDriverRepository({
    http.Client? client,
  }) : _client = client ?? http.Client();

  final http.Client _client;

  Future<LoginResult> login({
    required String email,
    required String password,
  }) async {
    final Uri uri = Uri.parse(
      'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=$_firebaseApiKey',
    );

    final http.Response response = await _client.post(
      uri,
      headers: <String, String>{
        'Content-Type': 'application/json',
      },
      body: jsonEncode(<String, dynamic>{
        'email': email.trim(),
        'password': password,
        'returnSecureToken': true,
      }),
    );

    final Map<String, dynamic> payload = _decodeJsonMap(response.body);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      final String message = _extractAuthError(payload);
      throw Exception(message);
    }

    final String idToken = (payload['idToken'] as String?)?.trim() ?? '';
    final String localId = (payload['localId'] as String?)?.trim() ?? '';
    final String normalizedEmail = (payload['email'] as String?)?.trim().toLowerCase() ?? email.trim().toLowerCase();
    if (idToken.isEmpty || localId.isEmpty) {
      throw Exception('Firebase login response is missing account identifiers.');
    }

    final Map<String, dynamic>? profile = await _fetchDocument(
      path: 'users/$localId',
      idToken: idToken,
    );
    if (profile == null) {
      throw Exception('No driver profile was found for this Firebase account.');
    }

    if ((profile['role'] as String?) != 'Driver') {
      throw Exception('This account is not registered as a driver.');
    }
    if (profile['active'] == false) {
      throw Exception('This driver account is inactive.');
    }

    final String managerId = (profile['managerId'] as String?)?.trim() ?? '';
    if (managerId.isEmpty) {
      throw Exception('This driver account is missing a manager assignment.');
    }

    return LoginResult(
      session: DriverSession(
        id: localId,
        email: normalizedEmail,
        driverName: (profile['name'] as String?)?.trim().isNotEmpty == true
            ? (profile['name'] as String).trim()
            : 'Driver',
        managerId: managerId,
        idToken: idToken,
      ),
    );
  }

  Future<List<DriverTask>> fetchAssignedTasks({
    required DriverSession session,
  }) async {
    final Map<String, dynamic>? managerResources = await _fetchDocument(
      path: 'managerResources/${session.managerId}',
      idToken: session.idToken,
    );
    if (managerResources == null) {
      return const <DriverTask>[];
    }

    final List<dynamic> rawAssignments = (managerResources['taskAssignments'] as List<dynamic>?) ??
        (managerResources['task_assignments'] as List<dynamic>?) ??
        const <dynamic>[];

    final List<Map<String, dynamic>> assignments = rawAssignments
        .whereType<Map<String, dynamic>>()
        .where((Map<String, dynamic> assignment) {
          if ((assignment['status'] as String?) == 'completed') {
            return false;
          }

          final String assignmentDriverId = (assignment['driverId'] as String?)?.trim() ?? '';
          if (assignmentDriverId == session.id) {
            return true;
          }

          return false;
        })
        .toList()
      ..sort((Map<String, dynamic> left, Map<String, dynamic> right) {
        final int leftSequence = _asInt(left['sequence']);
        final int rightSequence = _asInt(right['sequence']);
        return leftSequence.compareTo(rightSequence);
      });

    final Set<String> moveIds = assignments
        .map((Map<String, dynamic> assignment) => (assignment['moveId'] as String?)?.trim() ?? '')
        .where((String moveId) => moveId.isNotEmpty)
        .toSet();

    final Map<String, Map<String, dynamic>> movesById = <String, Map<String, dynamic>>{};
    for (final String moveId in moveIds) {
      final Map<String, dynamic>? move = await _fetchDocument(
        path: 'moves/$moveId',
        idToken: session.idToken,
      );
      if (move != null) {
        movesById[moveId] = move;
      }
    }

    return assignments
        .map((Map<String, dynamic> assignment) => _buildTask(
              assignment: assignment,
              move: movesById[(assignment['moveId'] as String?)?.trim() ?? ''],
            ))
        .toList();
  }

  Future<Map<String, dynamic>?> _fetchDocument({
    required String path,
    required String idToken,
  }) async {
    final Uri uri = Uri.parse(
      'https://firestore.googleapis.com/v1/projects/$_firebaseProjectId/databases/(default)/documents/$path',
    );

    final http.Response response = await _client.get(
      uri,
      headers: <String, String>{
        'Authorization': 'Bearer $idToken',
      },
    );

    if (response.statusCode == 404) {
      return null;
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw Exception('Firestore request failed for "$path" (${response.statusCode}).');
    }

    final Map<String, dynamic> payload = _decodeJsonMap(response.body);
    final Map<String, dynamic> fields = (payload['fields'] as Map<String, dynamic>?) ?? <String, dynamic>{};
    final Map<String, dynamic> data = <String, dynamic>{};
    fields.forEach((String key, dynamic value) {
      data[key] = _decodeFirestoreValue(value);
    });
    return data;
  }

  DriverTask _buildTask({
    required Map<String, dynamic> assignment,
    required Map<String, dynamic>? move,
  }) {
    final bool isReturnTask = (assignment['taskType'] as String?) == 'return';
    final Map<String, dynamic>? moveStartPoint = _asMap(move?['startPoint']);
    final Map<String, dynamic>? moveEndPoint = _asMap(move?['endPoint']);

    final TaskLocation origin = _buildLocation(
      label: _asString(assignment['startLabel'], fallback: 'Origin'),
      point: isReturnTask ? moveEndPoint : moveStartPoint,
    );
    final TaskLocation destination = _buildLocation(
      label: _asString(assignment['endLabel'], fallback: 'Destination'),
      point: isReturnTask ? moveStartPoint : moveEndPoint,
    );

    final String moveName = _asString(assignment['moveName'], fallback: 'Rig task');
    final String tripLabel = _asString(assignment['tripLabel'], fallback: '');
    final String simpleLoadLabel = _asString(assignment['simpleLoadLabel'], fallback: 'Assigned task');
    final String loadCode = _asString(assignment['loadCode'], fallback: '');
    final String title = tripLabel.isNotEmpty && tripLabel != simpleLoadLabel
        ? '$moveName - $tripLabel'
        : moveName;

    return DriverTask(
      id: _asString(assignment['id'], fallback: DateTime.now().millisecondsSinceEpoch.toString()),
      title: title,
      assetName: loadCode.isNotEmpty ? loadCode : simpleLoadLabel,
      origin: origin,
      destination: destination,
      scheduledWindow: _buildScheduledWindow(assignment),
      status: _buildTaskStatus(assignment),
      etaMinutes: _buildEtaMinutes(assignment, move),
      totalDistanceKm: _buildDistanceKm(assignment, move),
      routePoints: _buildRoutePoints(origin: origin, destination: destination),
      instructions: _buildInstructions(assignment, origin: origin, destination: destination),
    );
  }

  TaskLocation _buildLocation({
    required String label,
    required Map<String, dynamic>? point,
  }) {
    final double? latitude = _asDouble(point?['lat']);
    final double? longitude = _asDouble(point?['lng']);

    return TaskLocation(
      label: label,
      latitude: latitude ?? _fallbackLatitude,
      longitude: longitude ?? _fallbackLongitude,
    );
  }

  DriverTaskStatus _buildTaskStatus(Map<String, dynamic> assignment) {
    final String status = _asString(assignment['status']).toLowerCase();
    final bool hasStartedOutbound = assignment['moveStartedAt'] != null;
    final bool hasStartedReturn = assignment['returnMoveStartedAt'] != null;

    if (hasStartedOutbound || hasStartedReturn) {
      return DriverTaskStatus.inProgress;
    }

    if (status == 'active') {
      return DriverTaskStatus.ready;
    }

    return DriverTaskStatus.pending;
  }

  String _buildScheduledWindow(Map<String, dynamic> assignment) {
    final int plannedStartMinute = _asInt(assignment['plannedStartMinute']);
    if (plannedStartMinute > 0) {
      return 'Planned +${plannedStartMinute} min';
    }

    final String assignedAt = _asString(assignment['assignedAt']);
    if (assignedAt.isNotEmpty) {
      final DateTime? parsed = DateTime.tryParse(assignedAt);
      if (parsed != null) {
        final String hh = parsed.hour.toString().padLeft(2, '0');
        final String mm = parsed.minute.toString().padLeft(2, '0');
        return '${parsed.year}-${parsed.month.toString().padLeft(2, '0')}-${parsed.day.toString().padLeft(2, '0')} | $hh:$mm';
      }
    }

    return 'Dispatch pending';
  }

  int _buildEtaMinutes(Map<String, dynamic> assignment, Map<String, dynamic>? move) {
    final Map<String, dynamic>? stagePlan = _asMap(assignment['stagePlan']);
    final Map<String, dynamic>? rigMove = _asMap(stagePlan?['rigMove']);
    final int duration = _asInt(rigMove?['finishMinute']) - _asInt(rigMove?['startMinute']);
    if (duration > 0) {
      return duration;
    }

    final String routeTime = _asString(move?['routeTime']);
    final RegExp match = RegExp(r'(\d+)').firstMatch(routeTime);
    if (match != null) {
      return int.tryParse(match.group(1) ?? '') ?? 0;
    }

    return 0;
  }

  int _buildDistanceKm(Map<String, dynamic> assignment, Map<String, dynamic>? move) {
    final dynamic routeKm = move?['routeKm'];
    if (routeKm is num) {
      return routeKm.round();
    }

    final String routeLabel = _asString(move?['routeKm']);
    final RegExp match = RegExp(r'(\d+)').firstMatch(routeLabel);
    if (match != null) {
      return int.tryParse(match.group(1) ?? '') ?? 0;
    }

    final TaskLocation origin = _buildLocation(
      label: _asString(assignment['startLabel'], fallback: 'Origin'),
      point: _asMap(move?['startPoint']),
    );
    final TaskLocation destination = _buildLocation(
      label: _asString(assignment['endLabel'], fallback: 'Destination'),
      point: _asMap(move?['endPoint']),
    );
    return _estimateDistanceKm(origin: origin, destination: destination);
  }

  List<RouteCheckpoint> _buildRoutePoints({
    required TaskLocation origin,
    required TaskLocation destination,
  }) {
    return <RouteCheckpoint>[
      RouteCheckpoint(x: 0.10, y: 0.78, label: origin.label, speedKph: 0),
      RouteCheckpoint(x: 0.32, y: 0.64, label: 'Transit corridor', speedKph: 42),
      RouteCheckpoint(x: 0.56, y: 0.50, label: 'Highway segment', speedKph: 68),
      RouteCheckpoint(x: 0.78, y: 0.33, label: 'Final approach', speedKph: 34),
      RouteCheckpoint(x: 0.90, y: 0.20, label: destination.label, speedKph: 0),
    ];
  }

  List<String> _buildInstructions(
    Map<String, dynamic> assignment, {
    required TaskLocation origin,
    required TaskLocation destination,
  }) {
    final String tripLabel = _asString(assignment['tripLabel'], fallback: 'Assigned route');
    return <String>[
      'Depart from ${origin.label}.',
      'Follow the assigned route for $tripLabel.',
      'Arrive at ${destination.label} and update dispatch.',
    ];
  }

  int _estimateDistanceKm({
    required TaskLocation origin,
    required TaskLocation destination,
  }) {
    final double latDelta = (destination.latitude - origin.latitude).abs();
    final double lngDelta = (destination.longitude - origin.longitude).abs();
    final double roughKm = ((latDelta * 111) + (lngDelta * 96)) * 0.85;
    return roughKm.isFinite ? roughKm.round() : 0;
  }

  Map<String, dynamic> _decodeJsonMap(String source) {
    final dynamic decoded = jsonDecode(source);
    if (decoded is Map<String, dynamic>) {
      return decoded;
    }
    return <String, dynamic>{};
  }

  dynamic _decodeFirestoreValue(dynamic value) {
    if (value is! Map<String, dynamic>) {
      return value;
    }

    if (value.containsKey('stringValue')) {
      return value['stringValue'] as String? ?? '';
    }
    if (value.containsKey('integerValue')) {
      return int.tryParse(value['integerValue'].toString()) ?? 0;
    }
    if (value.containsKey('doubleValue')) {
      return (value['doubleValue'] as num?)?.toDouble() ?? 0.0;
    }
    if (value.containsKey('booleanValue')) {
      return value['booleanValue'] == true;
    }
    if (value.containsKey('timestampValue')) {
      return value['timestampValue'] as String?;
    }
    if (value.containsKey('nullValue')) {
      return null;
    }
    if (value.containsKey('arrayValue')) {
      final List<dynamic> values =
          ((value['arrayValue'] as Map<String, dynamic>?)?['values'] as List<dynamic>?) ?? const <dynamic>[];
      return values.map<dynamic>(_decodeFirestoreValue).toList();
    }
    if (value.containsKey('mapValue')) {
      final Map<String, dynamic> fields =
          ((value['mapValue'] as Map<String, dynamic>?)?['fields'] as Map<String, dynamic>?) ?? <String, dynamic>{};
      final Map<String, dynamic> map = <String, dynamic>{};
      fields.forEach((String key, dynamic nestedValue) {
        map[key] = _decodeFirestoreValue(nestedValue);
      });
      return map;
    }

    return null;
  }

  String _extractAuthError(Map<String, dynamic> payload) {
    final String code = (((payload['error'] as Map<String, dynamic>?)?['message']) as String? ?? '').trim();
    switch (code) {
      case 'EMAIL_NOT_FOUND':
      case 'INVALID_PASSWORD':
      case 'INVALID_LOGIN_CREDENTIALS':
        return 'Invalid driver credentials.';
      case 'USER_DISABLED':
        return 'This Firebase account is disabled.';
      default:
        return code.isNotEmpty ? 'Firebase login failed: $code' : 'Firebase login failed.';
    }
  }

  Map<String, dynamic>? _asMap(dynamic value) {
    return value is Map<String, dynamic> ? value : null;
  }

  String _asString(dynamic value, {String fallback = ''}) {
    final String text = (value as String?)?.trim() ?? '';
    return text.isNotEmpty ? text : fallback;
  }

  int _asInt(dynamic value) {
    if (value is int) {
      return value;
    }
    if (value is num) {
      return value.round();
    }
    return int.tryParse(value?.toString() ?? '') ?? 0;
  }

  double? _asDouble(dynamic value) {
    if (value is double) {
      return value;
    }
    if (value is num) {
      return value.toDouble();
    }
    return double.tryParse(value?.toString() ?? '');
  }
}
