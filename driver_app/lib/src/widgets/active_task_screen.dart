import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:geolocator/geolocator.dart';
import 'package:latlong2/latlong.dart';

import '../models/driver_task.dart';
import '../models/navigation_route.dart';
import '../models/task_location.dart';
import '../services/navigation_service.dart';

class ActiveTaskScreen extends StatefulWidget {
  const ActiveTaskScreen({
    super.key,
    required this.task,
    required this.driverName,
    required this.onBack,
  });

  final DriverTask task;
  final String driverName;
  final VoidCallback onBack;

  @override
  State<ActiveTaskScreen> createState() => _ActiveTaskScreenState();
}

class _ActiveTaskScreenState extends State<ActiveTaskScreen> {
  final NavigationService _navigationService = NavigationService();
  final MapController _mapController = MapController();

  Timer? _locationPollTimer;
  Position? _currentPosition;
  NavigationRoute? _route;
  String? _error;
  bool _isLoading = true;
  bool _isRefreshingRoute = false;
  bool _isMapReady = false;
  DateTime? _lastRouteRefreshAt;

  @override
  void initState() {
    super.initState();
    _startNavigation();
  }

  @override
  void dispose() {
    _locationPollTimer?.cancel();
    super.dispose();
  }

  Future<void> _startNavigation() async {
    setState(() {
      _isLoading = true;
      _error = null;
    });

    try {
      final bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
      if (!serviceEnabled) {
        throw Exception('Location services are disabled on this device.');
      }

      LocationPermission permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) {
        throw Exception('Location permission is required to start navigation.');
      }

      final Position current = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.medium,
        ),
      );

      if (!mounted) {
        return;
      }

      setState(() {
        _currentPosition = current;
      });

      await _refreshRoute(force: true);
      _centerOnCurrentLocation(zoom: 14.5);
      _startLocationPolling();
    } catch (error) {
      if (!mounted) {
        return;
      }
      setState(() {
        _error = error.toString().replaceFirst('Exception: ', '');
      });
    } finally {
      if (mounted) {
        setState(() {
          _isLoading = false;
        });
      }
    }
  }

  void _startLocationPolling() {
    _locationPollTimer?.cancel();
    _locationPollTimer = Timer.periodic(const Duration(seconds: 8), (_) async {
      try {
        final Position position = await Geolocator.getCurrentPosition(
          locationSettings: const LocationSettings(
            accuracy: LocationAccuracy.medium,
          ),
        );

        if (!mounted) {
          return;
        }

        setState(() {
          _currentPosition = position;
        });

        await _refreshRouteIfNeeded();
      } catch (_) {
        // Keep the last known position if the next poll fails.
      }
    });
  }

  Future<void> _refreshRouteIfNeeded() async {
    final DateTime now = DateTime.now();
    final bool isStale = _lastRouteRefreshAt == null ||
        now.difference(_lastRouteRefreshAt!) >= const Duration(seconds: 20);
    if (!isStale || _isRefreshingRoute) {
      return;
    }
    await _refreshRoute();
  }

  Future<void> _refreshRoute({bool force = false}) async {
    final Position? position = _currentPosition;
    if (position == null || _isRefreshingRoute) {
      return;
    }

    if (!force &&
        _lastRouteRefreshAt != null &&
        DateTime.now().difference(_lastRouteRefreshAt!) < const Duration(seconds: 20)) {
      return;
    }

    setState(() {
      _isRefreshingRoute = true;
      _error = null;
    });

    try {
      final NavigationRoute route = await _navigationService.fetchDrivingRoute(
        origin: LatLng(position.latitude, position.longitude),
        destination: widget.task.destination,
      );

      if (!mounted) {
        return;
      }

      setState(() {
        _route = route;
        _lastRouteRefreshAt = DateTime.now();
      });

      _fitRoute();
    } catch (error) {
      if (!mounted) {
        return;
      }
      setState(() {
        _error = error.toString();
      });
    } finally {
      if (mounted) {
        setState(() {
          _isRefreshingRoute = false;
        });
      }
    }
  }

  void _centerOnCurrentLocation({double zoom = 15.0}) {
    final Position? current = _currentPosition;
    if (current == null || !_isMapReady) {
      return;
    }
    _mapController.move(
      LatLng(current.latitude, current.longitude),
      zoom,
    );
  }

  void _fitRoute() {
    final Position? current = _currentPosition;
    final NavigationRoute? route = _route;
    if (current == null || route == null || route.path.isEmpty || !_isMapReady) {
      return;
    }

    final List<LatLng> points = <LatLng>[
      LatLng(current.latitude, current.longitude),
      widget.task.destination.toLatLng(),
      ...route.path,
    ];

    _mapController.fitCamera(
      CameraFit.bounds(
        bounds: LatLngBounds.fromPoints(points),
        padding: const EdgeInsets.all(72),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final Position? current = _currentPosition;
    final NavigationRoute? route = _route;
    final List<String> instructions = route?.instructions.isNotEmpty == true
        ? route!.instructions.take(3).toList()
        : widget.task.instructions;
    final String locationStatus = current == null
        ? 'Waiting for GPS'
        : 'GPS ${current.latitude.toStringAsFixed(5)}, ${current.longitude.toStringAsFixed(5)}';
    final double liveSpeed = current == null || !current.speed.isFinite ? 0 : current.speed;
    final int speedKph = (liveSpeed * 3.6).clamp(0, 220).round();
    final String nextInstruction = instructions.isEmpty ? 'Continue to destination' : instructions.first;
    final String secondaryInstruction = instructions.length > 1 ? instructions[1] : 'Then continue on planned route';
    final String etaLabel = route == null ? '--' : '${route.etaMinutes} min';
    final String remainingLabel = route == null ? '--' : '${route.distanceKm} km';
    final LatLng mapCenter = current == null
        ? widget.task.destination.toLatLng()
        : LatLng(current.latitude, current.longitude);

    return Scaffold(
      body: Stack(
        children: <Widget>[
          Positioned.fill(
            child: _isLoading
                ? const Center(child: CircularProgressIndicator())
                : FlutterMap(
                    mapController: _mapController,
                    options: MapOptions(
                      initialCenter: mapCenter,
                      initialZoom: 14,
                      interactionOptions: const InteractionOptions(
                        flags: InteractiveFlag.all,
                      ),
                      onMapReady: () {
                        if (mounted) {
                          setState(() {
                            _isMapReady = true;
                          });
                        } else {
                          _isMapReady = true;
                        }
                        if (_route != null && _route!.path.isNotEmpty) {
                          _fitRoute();
                        } else {
                          _centerOnCurrentLocation(zoom: 14.5);
                        }
                      },
                    ),
                    children: <Widget>[
                      TileLayer(
                        urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                        userAgentPackageName: 'com.example.rigsync_driver_app',
                      ),
                      PolylineLayer(
                        polylines: route == null
                            ? const <Polyline>[]
                            : <Polyline>[
                                Polyline(
                                  points: route.path,
                                  color: const Color(0xFFC6FF00),
                                  strokeWidth: 5,
                                ),
                              ],
                      ),
                      MarkerLayer(
                        markers: <Marker>[
                          Marker(
                            point: widget.task.destination.toLatLng(),
                            width: 60,
                            height: 60,
                            child: const _DestinationMarker(),
                          ),
                          if (current != null)
                            Marker(
                              point: LatLng(current.latitude, current.longitude),
                              width: 56,
                              height: 56,
                              child: const _DriverMarker(),
                            ),
                        ],
                      ),
                      RichAttributionWidget(
                        attributions: <SourceAttribution>[
                          TextSourceAttribution(
                            'OpenStreetMap contributors, CARTO',
                            onTap: null,
                          ),
                        ],
                      ),
                    ],
                  ),
          ),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
              child: Column(
                children: <Widget>[
                  Row(
                    children: <Widget>[
                      _CircleActionButton(
                        icon: Icons.arrow_back_rounded,
                        onTap: widget.onBack,
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: _NavigationBanner(
                          instruction: nextInstruction,
                          secondary: secondaryInstruction,
                          distanceLabel: remainingLabel,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 10),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      decoration: BoxDecoration(
                        color: const Color(0xE611161D),
                        borderRadius: BorderRadius.circular(16),
                        border: Border.all(color: const Color(0x14FFFFFF)),
                      ),
                      child: Text(
                        '${widget.task.title} | ${_isRefreshingRoute ? 'Refreshing route...' : locationStatus}',
                        style: theme.textTheme.bodyMedium,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
          Positioned(
            right: 16,
            top: 190,
            child: Column(
              children: <Widget>[
                _CircleActionButton(
                  icon: Icons.my_location_rounded,
                  onTap: _centerOnCurrentLocation,
                ),
                const SizedBox(height: 14),
                _CircleActionButton(
                  icon: Icons.route_rounded,
                  onTap: () => _refreshRoute(force: true),
                ),
                const SizedBox(height: 14),
                const _CircleActionButton(
                  icon: Icons.volume_up_rounded,
                ),
                const SizedBox(height: 14),
                const _CircleActionButton(
                  icon: Icons.explore_rounded,
                ),
              ],
            ),
          ),
          if (_error != null)
            Positioned(
              left: 16,
              right: 72,
              bottom: 150,
              child: Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: const Color(0xEE241317),
                  borderRadius: BorderRadius.circular(18),
                ),
                child: Text(
                  _error!,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: const Color(0xFFFF9C9C),
                  ),
                ),
              ),
            ),
          Positioned(
            left: 16,
            bottom: 124,
            child: _SpeedPanel(
              speedKph: speedKph,
              speedLimit: 25,
            ),
          ),
          Align(
            alignment: Alignment.bottomCenter,
            child: SafeArea(
              top: false,
              child: Container(
                width: double.infinity,
                margin: const EdgeInsets.fromLTRB(8, 0, 8, 8),
                decoration: const BoxDecoration(
                  color: Color(0xF6000000),
                  borderRadius: BorderRadius.vertical(top: Radius.circular(28), bottom: Radius.circular(28)),
                ),
                padding: const EdgeInsets.fromLTRB(20, 12, 20, 18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.center,
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Container(
                      width: 46,
                      height: 4,
                      decoration: BoxDecoration(
                        color: Colors.white30,
                        borderRadius: BorderRadius.circular(999),
                      ),
                    ),
                    const SizedBox(height: 10),
                    Text(
                      etaLabel,
                      style: theme.textTheme.displaySmall?.copyWith(
                        fontSize: 42,
                        color: const Color(0xFFC6FF90),
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      '$remainingLabel | ${widget.task.destination.label}',
                      style: theme.textTheme.bodyLarge?.copyWith(
                        color: Colors.white70,
                      ),
                    ),
                    const SizedBox(height: 16),
                    Row(
                      children: <Widget>[
                        Expanded(
                          child: _BottomActionButton(
                            icon: Icons.close_rounded,
                            label: 'Exit',
                            onTap: widget.onBack,
                          ),
                        ),
                        const SizedBox(width: 16),
                        Expanded(
                          child: _BottomActionButton(
                            icon: Icons.alt_route_rounded,
                            label: 'Route',
                            onTap: () => _refreshRoute(force: true),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _InfoChip extends StatelessWidget {
  const _InfoChip({
    required this.label,
    required this.value,
  });

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xD910151C),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: const Color(0x14FFFFFF)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(label, style: theme.textTheme.bodyMedium),
          const SizedBox(height: 6),
          Text(
            value,
            style: theme.textTheme.titleMedium?.copyWith(color: Colors.white),
          ),
        ],
      ),
    );
  }
}

class _NavigationBanner extends StatelessWidget {
  const _NavigationBanner({
    required this.instruction,
    required this.secondary,
    required this.distanceLabel,
  });

  final String instruction;
  final String secondary;
  final String distanceLabel;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 16),
      decoration: BoxDecoration(
        color: const Color(0xFF128742),
        borderRadius: BorderRadius.circular(24),
        boxShadow: const <BoxShadow>[
          BoxShadow(
            color: Color(0x33000000),
            blurRadius: 18,
            offset: Offset(0, 10),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              const Padding(
                padding: EdgeInsets.only(top: 2),
                child: Icon(
                  Icons.turn_left_rounded,
                  color: Colors.white,
                  size: 40,
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      instruction,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.displaySmall?.copyWith(
                        fontSize: 30,
                        color: Colors.white,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      distanceLabel,
                      style: theme.textTheme.titleLarge?.copyWith(
                        color: Colors.white,
                      ),
                    ),
                  ],
                ),
              ),
              Container(
                width: 58,
                height: 58,
                decoration: const BoxDecoration(
                  color: Color(0xFFF4F3EE),
                  shape: BoxShape.circle,
                ),
                child: const Icon(
                  Icons.mic_none_rounded,
                  color: Color(0xFF128742),
                  size: 30,
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              color: const Color(0x33000000),
              borderRadius: BorderRadius.circular(14),
            ),
            child: Text(
              'Then $secondary',
              style: theme.textTheme.titleMedium?.copyWith(
                color: Colors.white,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _CircleActionButton extends StatelessWidget {
  const _CircleActionButton({
    required this.icon,
    this.onTap,
  });

  final IconData icon;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 58,
      height: 58,
      decoration: const BoxDecoration(
        color: Color(0xF6000000),
        shape: BoxShape.circle,
        boxShadow: <BoxShadow>[
          BoxShadow(
            color: Color(0x33000000),
            blurRadius: 16,
            spreadRadius: 1,
          ),
        ],
      ),
      child: IconButton(
        onPressed: onTap,
        icon: Icon(icon, color: Colors.white, size: 30),
      ),
    );
  }
}

class _SpeedPanel extends StatelessWidget {
  const _SpeedPanel({
    required this.speedKph,
    required this.speedLimit,
  });

  final int speedKph;
  final int speedLimit;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: const Color(0xF6000000),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Container(
            width: 60,
            height: 60,
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: Colors.black, width: 3),
            ),
            alignment: Alignment.center,
            child: Text(
              '$speedLimit',
              style: theme.textTheme.displaySmall?.copyWith(
                fontSize: 28,
                color: Colors.black,
                fontWeight: FontWeight.w800,
              ),
            ),
          ),
          const SizedBox(width: 10),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                '$speedKph',
                style: theme.textTheme.displaySmall?.copyWith(
                  fontSize: 34,
                  color: const Color(0xFFFFB321),
                  fontWeight: FontWeight.w700,
                ),
              ),
              Text(
                'km/h',
                style: theme.textTheme.titleMedium?.copyWith(
                  color: Colors.white,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _BottomActionButton extends StatelessWidget {
  const _BottomActionButton({
    required this.icon,
    required this.label,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(20),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
        decoration: BoxDecoration(
          color: const Color(0xFF11161D),
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: const Color(0x22FFFFFF)),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            Icon(icon, color: Colors.white, size: 28),
            const SizedBox(width: 10),
            Text(
              label,
              style: theme.textTheme.titleMedium?.copyWith(
                color: Colors.white,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _DestinationMarker extends StatelessWidget {
  const _DestinationMarker();

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Container(
          width: 18,
          height: 18,
          decoration: BoxDecoration(
            color: const Color(0xFFC6FF00),
            border: Border.all(color: Colors.black, width: 2),
            shape: BoxShape.circle,
          ),
        ),
        Container(
          width: 2,
          height: 18,
          color: const Color(0xFFC6FF00),
        ),
      ],
    );
  }
}

class _DriverMarker extends StatelessWidget {
  const _DriverMarker();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 22,
      height: 22,
      decoration: BoxDecoration(
        color: const Color(0xFF58D1FF),
        shape: BoxShape.circle,
        border: Border.all(color: Colors.white, width: 3),
        boxShadow: const <BoxShadow>[
          BoxShadow(
            color: Color(0x6658D1FF),
            blurRadius: 18,
            spreadRadius: 4,
          ),
        ],
      ),
    );
  }
}

extension on TaskLocation {
  LatLng toLatLng() {
    return LatLng(latitude, longitude);
  }
}
