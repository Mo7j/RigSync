import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:latlong2/latlong.dart';

import '../models/navigation_route.dart';
import '../models/task_location.dart';

class NavigationService {
  NavigationService({
    http.Client? client,
  }) : _client = client ?? http.Client();

  final http.Client _client;

  Future<NavigationRoute> fetchDrivingRoute({
    required LatLng origin,
    required TaskLocation destination,
  }) async {
    final Uri uri = Uri.parse(
      'https://router.project-osrm.org/route/v1/driving/'
      '${origin.longitude},${origin.latitude};'
      '${destination.longitude},${destination.latitude}'
      '?overview=full&geometries=geojson&steps=true',
    );

    final http.Response response = await _client.get(uri);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw NavigationException('OSRM routing failed (${response.statusCode}).');
    }

    final Map<String, dynamic> data = jsonDecode(response.body) as Map<String, dynamic>;
    if (data['code'] != 'Ok') {
      throw NavigationException('OSRM returned "${data['code']}".');
    }

    final List<dynamic> routes = data['routes'] as List<dynamic>? ?? <dynamic>[];
    if (routes.isEmpty) {
      throw const NavigationException('No route returned by routing service.');
    }

    final Map<String, dynamic> route = routes.first as Map<String, dynamic>;
    final Map<String, dynamic> geometry = route['geometry'] as Map<String, dynamic>? ?? <String, dynamic>{};
    final List<dynamic> coordinates = geometry['coordinates'] as List<dynamic>? ?? <dynamic>[];
    final List<dynamic> legs = route['legs'] as List<dynamic>? ?? <dynamic>[];
    final List<dynamic> steps = legs.isEmpty
        ? const <dynamic>[]
        : ((legs.first as Map<String, dynamic>)['steps'] as List<dynamic>? ?? <dynamic>[]);

    return NavigationRoute(
      path: coordinates
          .map((dynamic point) => point as List<dynamic>)
          .where((List<dynamic> point) => point.length >= 2)
          .map((List<dynamic> point) => LatLng((point[1] as num).toDouble(), (point[0] as num).toDouble()))
          .toList(),
      distanceMeters: (route['distance'] as num?)?.round() ?? 0,
      durationSeconds: (route['duration'] as num?)?.round() ?? 0,
      instructions: steps
          .map((dynamic step) => (step as Map<String, dynamic>)['maneuver'] as Map<String, dynamic>? ?? <String, dynamic>{})
          .map((Map<String, dynamic> maneuver) {
            final String type = (maneuver['type'] as String? ?? 'continue').replaceAll('_', ' ');
            final String modifier = (maneuver['modifier'] as String? ?? '').trim();
            return modifier.isEmpty ? _capitalize(type) : '${_capitalize(type)} $modifier';
          })
          .toList(),
    );
  }

  String _capitalize(String value) {
    if (value.isEmpty) {
      return value;
    }
    return '${value[0].toUpperCase()}${value.substring(1)}';
  }
}

class NavigationException implements Exception {
  const NavigationException(this.message);

  final String message;

  @override
  String toString() => message;
}
