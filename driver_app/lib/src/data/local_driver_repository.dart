import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/driver_assignment.dart';
import '../models/driver_session.dart';
import '../models/task_location.dart';
import '../models/telemetry_snapshot.dart';

class LocalDriverRepository {
  LocalDriverRepository({
    http.Client? client,
    String? firebaseApiKey,
    String? firebaseProjectId,
  })  : _client = client ?? http.Client(),
        _firebaseApiKey = firebaseApiKey ??
            const String.fromEnvironment(
              'RIGSYNC_FIREBASE_API_KEY',
              defaultValue: 'AIzaSyDPNmHSjioHB6k1vGS2g05SIHQ30Vw54aM',
            ),
        _firebaseProjectId = firebaseProjectId ??
            const String.fromEnvironment(
              'RIGSYNC_FIREBASE_PROJECT_ID',
              defaultValue: 'rigsync-38f79',
            );

  final http.Client _client;
  final String _firebaseApiKey;
  final String _firebaseProjectId;

  String? _idToken;
  String? _refreshToken;
  String? _driverUid;

  Uri get _identityToolkitBase => Uri.parse(
        'https://identitytoolkit.googleapis.com/v1',
      );

  Uri get _firestoreBase => Uri.parse(
        'https://firestore.googleapis.com/v1/projects/$_firebaseProjectId/databases/(default)/documents',
      );

  Future<(DriverSession, List<DriverAssignment>)> login({
    required String email,
    required String password,
  }) async {
    final String normalizedEmail = _normalizeCredential(email).toLowerCase();
    final String normalizedPassword = _normalizeCredential(password);

    final Map<String, dynamic> authPayload = await _postJson(
      _identityToolkitBase.replace(
        path: '${_identityToolkitBase.path}/accounts:signInWithPassword',
        queryParameters: <String, String>{'key': _firebaseApiKey},
      ),
      <String, dynamic>{
        'email': normalizedEmail,
        'password': normalizedPassword,
        'returnSecureToken': true,
      },
      authorized: false,
    );

    _idToken = authPayload['idToken']?.toString();
    _refreshToken = authPayload['refreshToken']?.toString();
    _driverUid = authPayload['localId']?.toString();

    if ((_idToken ?? '').isEmpty || (_driverUid ?? '').isEmpty) {
      throw Exception('Firebase sign-in did not return a valid driver session.');
    }

    final Map<String, dynamic>? profile = await _getDocument('users', _driverUid!);
    if (profile == null) {
      throw Exception('Driver profile was not found in Firebase users.');
    }

    final String role = profile['role']?.toString() ?? '';
    if (role.isNotEmpty && role != 'Driver') {
      throw Exception('This account is not registered as a driver.');
    }
    if (profile['active'] == false) {
      throw Exception('This driver account is inactive.');
    }

    final DriverSession session = _parseSession(<String, dynamic>{
      ...profile,
      'id': profile['id']?.toString().isNotEmpty == true ? profile['id'] : _driverUid,
      'email': profile['email'] ?? normalizedEmail,
    });

    final List<DriverAssignment> assignments = await fetchAssignments(session: session);
    return (session, assignments);
  }

  Future<List<DriverAssignment>> fetchAssignments({
    required DriverSession session,
  }) async {
    final Map<String, dynamic> resources = await _fetchManagerResources(session.managerId);
    final List<Map<String, dynamic>> taskAssignments =
        _asMapList(resources['taskAssignments'] ?? resources['task_assignments']);

    final List<Map<String, dynamic>> driverAssignments = taskAssignments.where((Map<String, dynamic> entry) {
      final String driverId = entry['driverId']?.toString().trim() ?? '';
      final String driverEmail = entry['driverEmail']?.toString().trim().toLowerCase() ?? '';
      return driverId == session.id ||
          (driverEmail.isNotEmpty && driverEmail == session.email.toLowerCase());
    }).toList();

    final (List<Map<String, dynamic>> normalizedAssignments, bool didNormalize) =
        _normalizeDriverAssignmentMaps(driverAssignments);
    final (List<Map<String, dynamic>> hydratedAssignments, bool didHydrate) =
        await _hydrateAssignmentLocations(normalizedAssignments);
    final bool didChange = didNormalize || didHydrate;

    if (didChange) {
      final Map<String, Map<String, dynamic>> normalizedById = <String, Map<String, dynamic>>{
        for (final Map<String, dynamic> entry in hydratedAssignments)
          if ((entry['id']?.toString() ?? '').isNotEmpty) entry['id'].toString(): entry,
      };

      await _saveManagerResources(session.managerId, <String, dynamic>{
        ...resources,
        'taskAssignments': taskAssignments.map((Map<String, dynamic> entry) {
          final String entryId = entry['id']?.toString() ?? '';
          return normalizedById[entryId] ?? entry;
        }).toList(),
      });
    }

    return _parseAssignments(hydratedAssignments);
  }

  Future<DriverSession> updateStatus({
    required DriverSession session,
    required String currentStatus,
    TelemetrySnapshot? telemetry,
  }) async {
    final Map<String, dynamic> resources = await _fetchManagerResources(session.managerId);
    final List<Map<String, dynamic>> drivers = _asMapList(resources['drivers']);
    final String nowIso = DateTime.now().toUtc().toIso8601String();
    bool found = false;

    final List<Map<String, dynamic>> updatedDrivers = drivers.map((Map<String, dynamic> driver) {
      final bool isTarget = _matchesDriver(driver, session);
      if (!isTarget) {
        return driver;
      }
      found = true;
      return <String, dynamic>{
        ...driver,
        'id': session.id,
        'email': session.email,
        'name': session.name,
        'managerId': session.managerId,
        'truckType': session.truckType,
        'role': 'Driver',
        'currentStatus': currentStatus,
        'availabilityStatus': currentStatus == 'offline' ? 'busy' : currentStatus,
        'updatedAt': nowIso,
        if (telemetry != null) 'lastLocation': _telemetryPayload(telemetry),
      };
    }).toList();

    if (!found) {
      updatedDrivers.add(<String, dynamic>{
        'id': session.id,
        'email': session.email,
        'name': session.name,
        'managerId': session.managerId,
        'truckType': session.truckType,
        'role': 'Driver',
        'currentStatus': currentStatus,
        'availabilityStatus': currentStatus == 'offline' ? 'busy' : currentStatus,
        'updatedAt': nowIso,
        if (telemetry != null) 'lastLocation': _telemetryPayload(telemetry),
      });
    }

    await _saveManagerResources(session.managerId, <String, dynamic>{
      ...resources,
      'drivers': updatedDrivers,
    });

    await _saveUserProfile(<String, dynamic>{
      'id': session.id,
      'name': session.name,
      'email': session.email,
      'managerId': session.managerId,
      'truckType': session.truckType,
      'role': 'Driver',
      'currentStatus': currentStatus,
      'updatedAt': nowIso,
      if (telemetry != null) 'lastLocation': _telemetryPayload(telemetry),
    });

    return session.copyWith(currentStatus: currentStatus);
  }

  Future<(DriverSession, List<DriverAssignment>)> submitEvent({
    required DriverSession session,
    required DriverAssignment assignment,
    required String type,
    required String stage,
    TelemetrySnapshot? telemetry,
    Map<String, dynamic>? flag,
  }) async {
    final Map<String, dynamic> resources = await _fetchManagerResources(session.managerId);
    final List<Map<String, dynamic>> taskAssignments =
        _asMapList(resources['taskAssignments'] ?? resources['task_assignments']);
    final List<Map<String, dynamic>> drivers = _asMapList(resources['drivers']);
    final String nowIso = DateTime.now().toUtc().toIso8601String();

    final List<Map<String, dynamic>> updatedAssignments = taskAssignments.map((Map<String, dynamic> entry) {
      if (entry['id']?.toString() != assignment.id) {
        return entry;
      }
      return _applyAssignmentEvent(
        entry: entry,
        type: type,
        stage: stage,
        timestampIso: nowIso,
        telemetry: telemetry,
        flag: flag,
      );
    }).toList();

    final String nextStatus = _deriveDriverStatusForEvent(
      type: type,
      assignment: assignment,
      stage: stage,
    );

    final List<Map<String, dynamic>> updatedDrivers = drivers.map((Map<String, dynamic> driver) {
      if (!_matchesDriver(driver, session)) {
        return driver;
      }
      return <String, dynamic>{
        ...driver,
        'currentStatus': nextStatus,
        'availabilityStatus': nextStatus == 'offline' ? 'busy' : nextStatus,
        'updatedAt': nowIso,
        if (telemetry != null) 'lastLocation': _telemetryPayload(telemetry),
      };
    }).toList();

    await _saveManagerResources(session.managerId, <String, dynamic>{
      ...resources,
      'drivers': updatedDrivers,
      'taskAssignments': updatedAssignments,
    });

    await _writeExecutionEvent(<String, dynamic>{
      'driverId': session.id,
      'driverEmail': session.email,
      'driverName': session.name,
      'managerId': session.managerId,
      'assignmentId': assignment.id,
      'moveId': assignment.moveId,
      'type': type,
      'stage': stage,
      'createdAt': nowIso,
      if (telemetry != null) 'position': _telemetryPayload(telemetry),
      if (flag != null) 'flag': flag,
    });

    final DriverSession nextSession = await updateStatus(
      session: session,
      currentStatus: nextStatus,
      telemetry: telemetry,
    );
    final List<DriverAssignment> nextAssignments = await fetchAssignments(session: nextSession);
    return (nextSession, nextAssignments);
  }

  Future<void> sendTelemetry({
    required DriverSession session,
    required DriverAssignment assignment,
    required TelemetrySnapshot telemetry,
  }) async {
    await submitEvent(
      session: session,
      assignment: assignment,
      type: 'locationUpdate',
      stage: _stageValue(assignment.currentStage),
      telemetry: telemetry,
    );
  }

  (List<Map<String, dynamic>>, bool) _normalizeDriverAssignmentMaps(
    List<Map<String, dynamic>> assignments,
  ) {
    final List<Map<String, dynamic>> normalized = assignments
        .map((Map<String, dynamic> entry) => Map<String, dynamic>.from(entry))
        .toList();
    normalized.sort((Map<String, dynamic> left, Map<String, dynamic> right) {
      final int progressOrder = _assignmentProgressRank(_parseAssignment(right))
          .compareTo(_assignmentProgressRank(_parseAssignment(left)));
      if (progressOrder != 0) {
        return progressOrder;
      }
      final int sequenceOrder =
          (int.tryParse(left['sequence']?.toString() ?? '') ?? 999).compareTo(
        int.tryParse(right['sequence']?.toString() ?? '') ?? 999,
      );
      if (sequenceOrder != 0) {
        return sequenceOrder;
      }
      final DateTime leftAssignedAt =
          _parseDate(left['assignedAt']?.toString()) ?? DateTime.fromMillisecondsSinceEpoch(0);
      final DateTime rightAssignedAt =
          _parseDate(right['assignedAt']?.toString()) ?? DateTime.fromMillisecondsSinceEpoch(0);
      return leftAssignedAt.compareTo(rightAssignedAt);
    });

    bool hasCurrentTask = false;
    bool didChange = false;
    final String updatedAt = DateTime.now().toUtc().toIso8601String();

    for (final Map<String, dynamic> assignment in normalized) {
      final String status = assignment['status']?.toString() ?? '';
      if (status == 'completed') {
        continue;
      }

      if (!_isActionableStatusValue(status)) {
        continue;
      }

      if (!hasCurrentTask) {
        hasCurrentTask = true;
        continue;
      }

      assignment['status'] = 'queued';
      assignment['updatedAt'] = updatedAt;
      didChange = true;
    }

    if (!hasCurrentTask) {
      for (final Map<String, dynamic> assignment in normalized) {
        final String status = assignment['status']?.toString() ?? '';
        if (status == 'queued' || status == 'foreman') {
          assignment['status'] = 'assigned';
          assignment['updatedAt'] = updatedAt;
          didChange = true;
          break;
        }
      }
    }

    normalized.sort((Map<String, dynamic> left, Map<String, dynamic> right) =>
        (int.tryParse(left['sequence']?.toString() ?? '') ?? 999).compareTo(
          int.tryParse(right['sequence']?.toString() ?? '') ?? 999,
        ));
    return (normalized, didChange);
  }

  bool _isActionableStatusValue(String status) {
    return status == 'assigned' ||
        status == 'accepted' ||
        status == 'active' ||
        status == 'paused';
  }

  Future<(List<Map<String, dynamic>>, bool)> _hydrateAssignmentLocations(
    List<Map<String, dynamic>> assignments,
  ) async {
    bool didChange = false;
    final Map<String, Map<String, dynamic>> moveCache = <String, Map<String, dynamic>>{};

    for (final Map<String, dynamic> assignment in assignments) {
      final bool hasStart = assignment['startPoint'] != null;
      final bool hasEnd = assignment['endPoint'] != null;
      if (hasStart && hasEnd) {
        continue;
      }

      final String moveId = assignment['moveId']?.toString() ?? '';
      if (moveId.isEmpty) {
        continue;
      }

      moveCache[moveId] ??= await _getDocument('moves', moveId) ?? <String, dynamic>{};
      final Map<String, dynamic> move = moveCache[moveId] ?? <String, dynamic>{};
      final dynamic moveStartPoint = move['startPoint'];
      final dynamic moveEndPoint = move['endPoint'];
      final String moveStartLabel = move['startLabel']?.toString() ?? '';
      final String moveEndLabel = move['endLabel']?.toString() ?? '';
      final bool isReturnTask = assignment['taskType']?.toString() == 'return';

      if (!hasStart) {
        assignment['startPoint'] =
            isReturnTask ? (moveEndPoint ?? moveStartPoint) : (moveStartPoint ?? moveEndPoint);
        didChange = true;
      }
      if (!hasEnd) {
        assignment['endPoint'] =
            isReturnTask ? (moveStartPoint ?? moveEndPoint) : (moveEndPoint ?? moveStartPoint);
        didChange = true;
      }
      if ((assignment['startLabel']?.toString().trim().isEmpty ?? true) && moveStartLabel.isNotEmpty) {
        assignment['startLabel'] =
            isReturnTask ? (moveEndLabel.isNotEmpty ? moveEndLabel : moveStartLabel) : moveStartLabel;
        didChange = true;
      }
      if ((assignment['endLabel']?.toString().trim().isEmpty ?? true) && moveEndLabel.isNotEmpty) {
        assignment['endLabel'] =
            isReturnTask ? (moveStartLabel.isNotEmpty ? moveStartLabel : moveEndLabel) : moveEndLabel;
        didChange = true;
      }
    }

    return (assignments, didChange);
  }

  String _stageValue(AssignmentStage stage) {
    switch (stage) {
      case AssignmentStage.rigDown:
        return 'rigDown';
      case AssignmentStage.rigMove:
        return 'rigMove';
      case AssignmentStage.rigUp:
        return 'rigUp';
      case AssignmentStage.completed:
        return 'completed';
    }
  }

  Future<Map<String, dynamic>> _fetchManagerResources(String managerId) async {
    final Map<String, dynamic>? document = await _getDocument('managerResources', managerId);
    return document ?? <String, dynamic>{
      'managerId': managerId,
      'fleet': <dynamic>[],
      'trucks': <dynamic>[],
      'drivers': <dynamic>[],
      'taskAssignments': <dynamic>[],
      'reports': <dynamic>[],
    };
  }

  Future<void> _saveManagerResources(String managerId, Map<String, dynamic> resources) async {
    await _patchDocument('managerResources', managerId, resources);
  }

  Future<void> _saveUserProfile(Map<String, dynamic> profile) async {
    final String id = profile['id']?.toString() ?? '';
    if (id.isEmpty) {
      return;
    }
    await _patchDocument('users', id, profile);
  }

  Future<void> _writeExecutionEvent(Map<String, dynamic> event) async {
    await _createDocument('executionEvents', event);
  }

  Future<Map<String, dynamic>?> _getDocument(String collection, String documentId) async {
    final http.Response response = await _authorizedRequest(
      () => _client.get(
        _firestoreBase.replace(path: '${_firestoreBase.path}/$collection/$documentId'),
        headers: _firestoreHeaders,
      ).timeout(const Duration(seconds: 12)),
    );

    if (response.statusCode == 404) {
      return null;
    }
    final Map<String, dynamic> payload = _decodeMap(response.body);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw Exception(_extractFirestoreError(payload, 'Failed to load $collection/$documentId.'));
    }
    return _decodeDocument(payload);
  }

  Future<void> _patchDocument(String collection, String documentId, Map<String, dynamic> data) async {
    final List<String> fieldPaths = data.keys.where((String key) => key.trim().isNotEmpty).toList();
    final List<String> queryPairs = fieldPaths
        .map((String key) => 'updateMask.fieldPaths=${Uri.encodeQueryComponent(key)}')
        .toList();
    final Uri uri = Uri.parse(
      '${_firestoreBase.toString()}/$collection/$documentId${queryPairs.isEmpty ? '' : '?${queryPairs.join('&')}'}',
    );

    final http.Response response = await _authorizedRequest(
      () => _client.patch(
        uri,
        headers: _firestoreHeaders,
        body: jsonEncode(_encodeDocumentBody(data)),
      ).timeout(const Duration(seconds: 12)),
    );

    final Map<String, dynamic> payload = _decodeMap(response.body);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw Exception(_extractFirestoreError(payload, 'Failed to save $collection/$documentId.'));
    }
  }

  Future<void> _createDocument(String collection, Map<String, dynamic> data) async {
    final http.Response response = await _authorizedRequest(
      () => _client.post(
        _firestoreBase.replace(path: '${_firestoreBase.path}/$collection'),
        headers: _firestoreHeaders,
        body: jsonEncode(_encodeDocumentBody(data)),
      ).timeout(const Duration(seconds: 12)),
    );

    final Map<String, dynamic> payload = _decodeMap(response.body);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw Exception(_extractFirestoreError(payload, 'Failed to create $collection document.'));
    }
  }

  Future<http.Response> _authorizedRequest(Future<http.Response> Function() request) async {
    final http.Response response = await request();
    if (response.statusCode != 401) {
      return response;
    }

    final bool refreshed = await _refreshAuthToken();
    if (!refreshed) {
      return response;
    }
    return request();
  }

  Future<bool> _refreshAuthToken() async {
    final String refreshToken = _refreshToken?.trim() ?? '';
    if (refreshToken.isEmpty) {
      return false;
    }

    final Uri uri = Uri.parse(
      'https://securetoken.googleapis.com/v1/token?key=$_firebaseApiKey',
    );
    final http.Response response = await _client.post(
      uri,
      headers: const <String, String>{
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=refresh_token&refresh_token=${Uri.encodeQueryComponent(refreshToken)}',
    ).timeout(const Duration(seconds: 12));

    final Map<String, dynamic> payload = _decodeMap(response.body);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return false;
    }

    _idToken = payload['id_token']?.toString() ?? _idToken;
    _refreshToken = payload['refresh_token']?.toString() ?? _refreshToken;
    _driverUid = payload['user_id']?.toString() ?? _driverUid;
    return (_idToken ?? '').isNotEmpty;
  }

  Map<String, String> get _firestoreHeaders => <String, String>{
        'Authorization': 'Bearer ${_idToken ?? ''}',
        'Content-Type': 'application/json',
      };

  Map<String, dynamic> _encodeDocumentBody(Map<String, dynamic> data) {
    return <String, dynamic>{
      'fields': data.map((String key, dynamic value) => MapEntry<String, dynamic>(key, _encodeFirestoreValue(value))),
    };
  }

  dynamic _encodeFirestoreValue(dynamic value) {
    if (value == null) {
      return <String, dynamic>{'nullValue': null};
    }
    if (value is bool) {
      return <String, dynamic>{'booleanValue': value};
    }
    if (value is int) {
      return <String, dynamic>{'integerValue': value.toString()};
    }
    if (value is double) {
      return <String, dynamic>{'doubleValue': value};
    }
    if (value is num) {
      return <String, dynamic>{'doubleValue': value.toDouble()};
    }
    if (value is DateTime) {
      return <String, dynamic>{'timestampValue': value.toUtc().toIso8601String()};
    }
    if (value is List) {
      return <String, dynamic>{
        'arrayValue': <String, dynamic>{
          'values': value.map<dynamic>(_encodeFirestoreValue).toList(),
        },
      };
    }
    if (value is Map) {
      final Map<String, dynamic> fields = <String, dynamic>{};
      value.forEach((dynamic rawKey, dynamic nestedValue) {
        fields[rawKey.toString()] = _encodeFirestoreValue(nestedValue);
      });
      return <String, dynamic>{
        'mapValue': <String, dynamic>{'fields': fields},
      };
    }
    return <String, dynamic>{'stringValue': value.toString()};
  }

  Map<String, dynamic> _decodeDocument(Map<String, dynamic> payload) {
    final Map<String, dynamic> fields =
        (payload['fields'] as Map<String, dynamic>?) ?? <String, dynamic>{};
    return fields.map((String key, dynamic value) => MapEntry<String, dynamic>(key, _decodeFirestoreValue(value)));
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
      return fields.map((String key, dynamic nestedValue) => MapEntry<String, dynamic>(key, _decodeFirestoreValue(nestedValue)));
    }
    return null;
  }

  Map<String, dynamic> _decodeMap(String body) {
    final dynamic decoded = jsonDecode(body);
    if (decoded is Map<String, dynamic>) {
      return decoded;
    }
    throw Exception('Unexpected Firebase response.');
  }

  String _extractFirestoreError(Map<String, dynamic> payload, String fallback) {
    final Map<String, dynamic>? error = payload['error'] as Map<String, dynamic>?;
    final String status = error?['status']?.toString() ?? '';
    final String message = error?['message']?.toString() ?? '';
    if (message.isNotEmpty) {
      return status.isNotEmpty ? '$status: $message' : message;
    }
    return fallback;
  }

  String _normalizeCredential(String value) {
    final String trimmed = value.trim();
    final StringBuffer buffer = StringBuffer();
    for (final int rune in trimmed.runes) {
      if (rune >= 0x0660 && rune <= 0x0669) {
        buffer.writeCharCode(0x30 + (rune - 0x0660));
      } else if (rune >= 0x06F0 && rune <= 0x06F9) {
        buffer.writeCharCode(0x30 + (rune - 0x06F0));
      } else {
        buffer.writeCharCode(rune);
      }
    }
    return buffer.toString();
  }

  List<Map<String, dynamic>> _asMapList(dynamic raw) {
    final List<dynamic> items = raw is List<dynamic> ? raw : const <dynamic>[];
    return items.whereType<Map>().map((Map item) => Map<String, dynamic>.from(item)).toList();
  }

  bool _matchesDriver(Map<String, dynamic> driver, DriverSession session) {
    final String driverId = driver['id']?.toString().trim() ?? '';
    final String email = driver['email']?.toString().trim().toLowerCase() ?? '';
    return driverId == session.id ||
        (email.isNotEmpty && email == session.email.trim().toLowerCase());
  }

  String _deriveDriverStatusForEvent({
    required String type,
    required DriverAssignment assignment,
    required String stage,
  }) {
    switch (type) {
      case 'paused':
        return 'busy';
      case 'resumed':
        return stage == 'rigMove' ? 'active' : 'busy';
      case 'locationUpdate':
      case 'stageStarted':
        return stage == 'rigMove' ? 'active' : 'busy';
      case 'stageCompleted':
        return assignment.currentStage == AssignmentStage.rigUp ? 'available' : 'busy';
      case 'flagSubmitted':
      case 'accepted':
      default:
        return assignment.currentStage == AssignmentStage.rigMove ? 'active' : 'busy';
    }
  }

  Map<String, dynamic> _applyAssignmentEvent({
    required Map<String, dynamic> entry,
    required String type,
    required String stage,
    required String timestampIso,
    TelemetrySnapshot? telemetry,
    Map<String, dynamic>? flag,
  }) {
    final Map<String, dynamic> updated = Map<String, dynamic>.from(entry);
    updated['updatedAt'] = timestampIso;

    final Map<String, dynamic> stageStatus = Map<String, dynamic>.from(
      updated['stageStatus'] is Map ? updated['stageStatus'] as Map : const <String, dynamic>{},
    );
    final Map<String, dynamic> stageCompletedAt = Map<String, dynamic>.from(
      updated['stageCompletedAt'] is Map ? updated['stageCompletedAt'] as Map : const <String, dynamic>{},
    );

    switch (type) {
      case 'accepted':
        updated['status'] = 'accepted';
        break;
      case 'paused':
        updated['status'] = 'paused';
        break;
      case 'resumed':
        updated['status'] = 'active';
        break;
      case 'stageStarted':
        updated['status'] = 'active';
        if (stage == 'rigMove') {
          updated['moveStartedAt'] = updated['moveStartedAt'] ?? timestampIso;
        }
        break;
      case 'stageCompleted':
        updated['status'] = stage == 'rigUp' ? 'completed' : 'active';
        if (stage == 'rigDown') {
          stageStatus['rigDownCompleted'] = true;
          stageCompletedAt['rigDown'] = stageCompletedAt['rigDown'] ?? timestampIso;
          updated['currentStage'] = 'rigMove';
        } else if (stage == 'rigMove') {
          stageStatus['rigMoveCompleted'] = true;
          stageCompletedAt['rigMove'] = stageCompletedAt['rigMove'] ?? timestampIso;
          updated['outboundArrivedAt'] = updated['outboundArrivedAt'] ?? timestampIso;
          updated['currentStage'] = 'rigUp';
        } else if (stage == 'rigUp') {
          stageStatus['rigUpCompleted'] = true;
          stageCompletedAt['rigUp'] = stageCompletedAt['rigUp'] ?? timestampIso;
          updated['currentStage'] = 'completed';
        }
        updated['stageStatus'] = stageStatus;
        updated['stageCompletedAt'] = stageCompletedAt;
        break;
      case 'flagSubmitted':
        final List<dynamic> flags = updated['flags'] is List ? List<dynamic>.from(updated['flags'] as List) : <dynamic>[];
        flags.add(<String, dynamic>{
          ...(flag ?? const <String, dynamic>{}),
          'id': (flag?['id']?.toString().isNotEmpty == true)
              ? flag!['id']
              : 'flag-${updated['id'] ?? ''}-${DateTime.now().millisecondsSinceEpoch}',
          'createdAt': timestampIso,
          'status': flag?['status'] ?? 'open',
        });
        updated['flags'] = flags;
        break;
      case 'locationUpdate':
        if (telemetry != null) {
          updated['lastLocation'] = _telemetryPayload(telemetry);
        }
        break;
    }

    return updated;
  }

  DriverSession _parseSession(Map<String, dynamic> raw) {
    return DriverSession(
      id: raw['id']?.toString() ?? '',
      name: raw['name']?.toString() ?? 'Driver',
      email: raw['email']?.toString() ?? '',
      managerId: raw['managerId']?.toString() ?? '',
      truckType: raw['truckType']?.toString() ?? '',
      currentStatus: raw['currentStatus']?.toString() ?? 'available',
    );
  }

  List<DriverAssignment> _parseAssignments(dynamic raw) {
    final List<Map<String, dynamic>> items = _asMapList(raw);
    final List<DriverAssignment> parsedAssignments = items
        .map(_parseAssignment)
        .where((DriverAssignment assignment) => assignment.id.isNotEmpty)
        .toList();
    final List<DriverAssignment> assignments = _normalizeAssignmentQueue(parsedAssignments);
    assignments.sort((DriverAssignment left, DriverAssignment right) {
      final int currentOrder = left.isCurrent == right.isCurrent ? 0 : (left.isCurrent ? -1 : 1);
      if (currentOrder != 0) {
        return currentOrder;
      }
      return left.sequence.compareTo(right.sequence);
    });
    return assignments;
  }

  List<DriverAssignment> _normalizeAssignmentQueue(List<DriverAssignment> assignments) {
    final List<DriverAssignment> ordered = List<DriverAssignment>.from(assignments)
      ..sort((DriverAssignment left, DriverAssignment right) {
        final int progressOrder = _assignmentProgressRank(right).compareTo(_assignmentProgressRank(left));
        if (progressOrder != 0) {
          return progressOrder;
        }
        final int sequenceOrder = left.sequence.compareTo(right.sequence);
        if (sequenceOrder != 0) {
          return sequenceOrder;
        }
        return (left.assignedAt ?? DateTime.fromMillisecondsSinceEpoch(0))
            .compareTo(right.assignedAt ?? DateTime.fromMillisecondsSinceEpoch(0));
      });

    bool hasCurrentTask = false;
    final List<DriverAssignment> normalized = ordered.map((DriverAssignment assignment) {
      if (assignment.status == AssignmentStatus.completed) {
        return assignment;
      }

      final bool isActionable = assignment.status == AssignmentStatus.assigned ||
          assignment.status == AssignmentStatus.accepted ||
          assignment.status == AssignmentStatus.active ||
          assignment.status == AssignmentStatus.paused;
      if (!isActionable) {
        return assignment;
      }

      if (!hasCurrentTask) {
        hasCurrentTask = true;
        return assignment;
      }

      return assignment.copyWith(status: AssignmentStatus.queued);
    }).toList();

    normalized.sort((DriverAssignment left, DriverAssignment right) {
      final int currentOrder = left.isCurrent == right.isCurrent ? 0 : (left.isCurrent ? -1 : 1);
      if (currentOrder != 0) {
        return currentOrder;
      }
      return left.sequence.compareTo(right.sequence);
    });
    return normalized;
  }

  int _assignmentProgressRank(DriverAssignment assignment) {
    final int stageRank = switch (assignment.currentStage) {
      AssignmentStage.rigDown => 1,
      AssignmentStage.rigMove => 2,
      AssignmentStage.rigUp => 3,
      AssignmentStage.completed => 4,
    };
    final int statusRank = switch (assignment.status) {
      AssignmentStatus.queued => 0,
      AssignmentStatus.assigned => 1,
      AssignmentStatus.accepted => 2,
      AssignmentStatus.active => 3,
      AssignmentStatus.paused => 4,
      AssignmentStatus.completed => 5,
    };
    return (stageRank * 10) + statusRank;
  }

  DriverAssignment _parseAssignment(Map<String, dynamic> raw) {
    return DriverAssignment(
      id: raw['id']?.toString() ?? '',
      moveId: raw['moveId']?.toString() ?? '',
      moveName: raw['moveName']?.toString() ?? 'Rig move',
      tripLabel: raw['tripLabel']?.toString() ?? raw['loadCode']?.toString() ?? 'Assigned trip',
      tripNumber: int.tryParse(raw['tripNumber']?.toString() ?? '') ?? 0,
      plannedTripCount: int.tryParse(raw['plannedTripCount']?.toString() ?? '') ?? 0,
      loadCode: raw['loadCode']?.toString() ?? '',
      startLabel: raw['startLabel']?.toString() ?? 'Source',
      endLabel: raw['endLabel']?.toString() ?? 'Destination',
      currentStage: _parseStage(raw['currentStage']?.toString()),
      status: _parseStatus(raw['status']?.toString()),
      sequence: int.tryParse(raw['sequence']?.toString() ?? '') ?? 999,
      assignedAt: _parseDate(raw['assignedAt']?.toString()),
      updatedAt: _parseDate(raw['updatedAt']?.toString()),
      pickupLocation: _parseTaskLocation(raw['startPoint'], raw['startLabel']?.toString() ?? 'Pickup'),
      destinationLocation: _parseTaskLocation(raw['endPoint'], raw['endLabel']?.toString() ?? 'Destination'),
    );
  }

  AssignmentStage _parseStage(String? raw) {
    switch (raw) {
      case 'rigDown':
        return AssignmentStage.rigDown;
      case 'rigMove':
        return AssignmentStage.rigMove;
      case 'rigUp':
        return AssignmentStage.rigUp;
      case 'completed':
        return AssignmentStage.completed;
      default:
        return AssignmentStage.rigDown;
    }
  }

  AssignmentStatus _parseStatus(String? raw) {
    switch (raw) {
      case 'assigned':
      case 'foreman':
        return AssignmentStatus.assigned;
      case 'accepted':
      case 'busy':
        return AssignmentStatus.accepted;
      case 'active':
        return AssignmentStatus.active;
      case 'paused':
        return AssignmentStatus.paused;
      case 'completed':
        return AssignmentStatus.completed;
      default:
        return AssignmentStatus.queued;
    }
  }

  DateTime? _parseDate(String? value) => value == null || value.isEmpty ? null : DateTime.tryParse(value);

  double? _parseDouble(dynamic value) {
    if (value is num) {
      return value.toDouble();
    }
    return double.tryParse(value?.toString() ?? '');
  }

  TaskLocation? _parseTaskLocation(dynamic rawPoint, String label) {
    double? latitude;
    double? longitude;

    if (rawPoint is List && rawPoint.length >= 2) {
      latitude = _parseDouble(rawPoint[0]);
      longitude = _parseDouble(rawPoint[1]);
    } else if (rawPoint is Map<String, dynamic>) {
      latitude = _parseDouble(rawPoint['lat']) ?? _parseDouble(rawPoint['latitude']);
      longitude = _parseDouble(rawPoint['lng']) ?? _parseDouble(rawPoint['longitude']);
    }

    if (latitude == null || longitude == null || !latitude.isFinite || !longitude.isFinite) {
      return null;
    }

    return TaskLocation(
      label: label,
      latitude: latitude,
      longitude: longitude,
    );
  }

  Map<String, dynamic> _telemetryPayload(TelemetrySnapshot telemetry) {
    return <String, dynamic>{
      'lat': telemetry.latitude,
      'lng': telemetry.longitude,
      'speedKph': telemetry.speedKph,
      'recordedAt': telemetry.recordedAt.toUtc().toIso8601String(),
    };
  }

  Future<Map<String, dynamic>> _postJson(
    Uri uri,
    Map<String, dynamic> payload, {
    required bool authorized,
  }) async {
    final http.Response response = authorized
        ? await _authorizedRequest(
            () => _client.post(
              uri,
              headers: authorized ? _firestoreHeaders : const <String, String>{'Content-Type': 'application/json'},
              body: jsonEncode(payload),
            ).timeout(const Duration(seconds: 12)),
          )
        : await _client.post(
            uri,
            headers: const <String, String>{'Content-Type': 'application/json'},
            body: jsonEncode(payload),
          ).timeout(const Duration(seconds: 12));

    final Map<String, dynamic> decoded = _decodeMap(response.body);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw Exception(_extractFirebaseError(decoded));
    }
    return decoded;
  }

  String _extractFirebaseError(Map<String, dynamic> payload) {
    final Map<String, dynamic>? error = payload['error'] as Map<String, dynamic>?;
    final String message = error?['message']?.toString() ?? payload['error']?.toString() ?? 'Firebase request failed.';
    switch (message) {
      case 'EMAIL_NOT_FOUND':
      case 'INVALID_LOGIN_CREDENTIALS':
      case 'INVALID_PASSWORD':
        return 'Invalid email or password.';
      case 'USER_DISABLED':
        return 'This driver account is disabled.';
      default:
        return message;
    }
  }
}
