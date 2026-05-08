import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:geolocator/geolocator.dart';
import 'package:latlong2/latlong.dart';

import '../l10n/app_strings.dart';
import '../models/driver_assignment.dart';
import '../models/driver_flag.dart';
import '../models/navigation_route.dart';
import '../models/task_location.dart';
import '../models/telemetry_snapshot.dart';
import '../services/navigation_service.dart';
import 'flag_submission_screen.dart';

class ActiveTaskScreen extends StatefulWidget {
  const ActiveTaskScreen({
    super.key,
    required this.assignment,
    required this.onBack,
    required this.onToggleLanguage,
    required this.onTelemetry,
    required this.onPause,
    required this.onResume,
    required this.onAccept,
    required this.onPrimaryAction,
    required this.onSubmitFlag,
    required this.isSubmitting,
  });

  final DriverAssignment assignment;
  final VoidCallback onBack;
  final VoidCallback onToggleLanguage;
  final Future<void> Function(TelemetrySnapshot telemetry) onTelemetry;
  final Future<void> Function() onPause;
  final Future<void> Function() onResume;
  final Future<void> Function() onAccept;
  final Future<void> Function(TelemetrySnapshot? telemetry) onPrimaryAction;
  final Future<void> Function(String flagCode, String reason) onSubmitFlag;
  final bool isSubmitting;

  @override
  State<ActiveTaskScreen> createState() => _ActiveTaskScreenState();
}

class _ActiveTaskScreenState extends State<ActiveTaskScreen> {
  static const Distance _distance = Distance();
  static const List<DriverFlagOption> _flagOptions = <DriverFlagOption>[
    DriverFlagOption(code: 'traffic', labelKey: 'flagTraffic'),
    DriverFlagOption(code: 'break', labelKey: 'flagBreak'),
    DriverFlagOption(code: 'prayer', labelKey: 'flagPrayer'),
    DriverFlagOption(code: 'mechanical', labelKey: 'flagMechanical'),
    DriverFlagOption(code: 'siteDelay', labelKey: 'flagSiteDelay'),
    DriverFlagOption(code: 'custom', labelKey: 'customFlag'),
  ];

  final MapController _mapController = MapController();
  final NavigationService _navigationService = NavigationService();

  Timer? _locationPollTimer;
  Position? _currentPosition;
  NavigationRoute? _route;
  String? _error;
  bool _isLoading = true;
  bool _isFetchingRoute = false;
  bool _isMapReady = false;
  bool _isFlagDialogOpen = false;
  LatLng? _lastRouteOrigin;
  String? _lastRouteTargetKey;
  int _routeRequestId = 0;

  @override
  void initState() {
    super.initState();
    _startTracking();
  }

  @override
  void didUpdateWidget(covariant ActiveTaskScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    final String oldTargetKey = _targetKeyFor(oldWidget.assignment);
    final String nextTargetKey = _targetKeyFor(widget.assignment);
    if (oldTargetKey != nextTargetKey ||
        oldWidget.assignment.currentStage != widget.assignment.currentStage) {
      setState(() {
        _route = null;
        _lastRouteTargetKey = null;
      });
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final List<LatLng> path = _effectiveRoutePath();
        if (path.isNotEmpty) {
          _focusOnRoute(path);
        }
      });
      _loadRoute(force: true);
    }
  }

  @override
  void dispose() {
    _locationPollTimer?.cancel();
    super.dispose();
  }

  TaskLocation? get _activeTarget {
    if (widget.assignment.currentStage == AssignmentStage.rigDown) {
      return widget.assignment.pickupLocation ?? widget.assignment.destinationLocation;
    }
    return widget.assignment.destinationLocation ?? widget.assignment.pickupLocation;
  }

  String _targetKeyFor(DriverAssignment assignment) {
    final TaskLocation? target = assignment.currentStage == AssignmentStage.rigDown
        ? assignment.pickupLocation ?? assignment.destinationLocation
        : assignment.destinationLocation ?? assignment.pickupLocation;
    if (target == null) {
      return '${assignment.id}-no-target';
    }
    return '${assignment.id}-${assignment.currentStage.name}-${target.latitude}-${target.longitude}';
  }

  Future<void> _startTracking() async {
    setState(() {
      _isLoading = true;
      _error = null;
    });

    try {
      final bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
      if (!serviceEnabled) {
        throw Exception('Location services are disabled.');
      }

      LocationPermission permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) {
        throw Exception('Location permission is required.');
      }

      final Position current = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.best),
      );

      if (!mounted) {
        return;
      }

      setState(() {
        _currentPosition = current;
      });

      unawaited(_loadRoute(force: true));
      _sendTelemetryInBackground(_telemetryFrom(current));
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
    _locationPollTimer = Timer.periodic(const Duration(seconds: 12), (_) async {
      try {
        final Position current = await Geolocator.getCurrentPosition(
          locationSettings: const LocationSettings(accuracy: LocationAccuracy.best),
        );
        if (!mounted) {
          return;
        }
        setState(() {
          _currentPosition = current;
        });
        await _loadRoute();
        _sendTelemetryInBackground(_telemetryFrom(current));
      } catch (_) {
        // Keep the last known location and route when a refresh fails.
      }
    });
  }

  void _sendTelemetryInBackground(TelemetrySnapshot telemetry) {
    unawaited(
      widget.onTelemetry(telemetry).catchError((Object _) {
        // Keep navigation responsive if sync fails.
      }),
    );
  }

  TelemetrySnapshot _telemetryFrom(Position current) {
    return TelemetrySnapshot(
      latitude: current.latitude,
      longitude: current.longitude,
      speedKph: current.speed.isFinite ? current.speed * 3.6 : 0,
      recordedAt: DateTime.now(),
    );
  }

  Future<void> _loadRoute({bool force = false}) async {
    final Position? current = _currentPosition;
    final TaskLocation? target = _activeTarget;
    if (current == null || target == null) {
      return;
    }

    final LatLng origin = LatLng(current.latitude, current.longitude);
    final String nextTargetKey = _targetKeyFor(widget.assignment);
    final bool movedFarEnough = _lastRouteOrigin == null || _distance(_lastRouteOrigin!, origin) > 500;
    final bool targetChanged = _lastRouteTargetKey != nextTargetKey;

    if (!force && !movedFarEnough && !targetChanged && _route != null) {
      return;
    }

    setState(() {
      _isFetchingRoute = true;
    });
    final int requestId = ++_routeRequestId;

    try {
      final NavigationRoute route = await _navigationService.fetchDrivingRoute(
        origin: origin,
        destination: target,
      );
      if (!mounted || requestId != _routeRequestId) {
        return;
      }
      setState(() {
        _route = route;
        _lastRouteOrigin = origin;
        _lastRouteTargetKey = nextTargetKey;
        _error = null;
      });
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _focusOnRoute(route.path);
      });
    } catch (error) {
      if (!mounted || requestId != _routeRequestId) {
        return;
      }
      setState(() {
        _error = error.toString().replaceFirst('Exception: ', '');
      });
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final List<LatLng> fallbackPath = _effectiveRoutePath();
        if (fallbackPath.isNotEmpty) {
          _focusOnRoute(fallbackPath);
        }
      });
    } finally {
      if (mounted && requestId == _routeRequestId) {
        setState(() {
          _isFetchingRoute = false;
        });
      }
    }
  }

  void _centerOnCurrentLocation() {
    final Position? current = _currentPosition;
    if (current == null || !_isMapReady) {
      return;
    }
    _mapController.move(LatLng(current.latitude, current.longitude), 13.5);
  }

  void _focusOnRoute(List<LatLng> points) {
    if (!_isMapReady || points.isEmpty) {
      return;
    }
    if (points.length == 1) {
      _mapController.move(points.first, 14);
      return;
    }
    final LatLngBounds bounds = LatLngBounds.fromPoints(points);
    _mapController.fitCamera(
      CameraFit.bounds(
        bounds: bounds,
        padding: const EdgeInsets.fromLTRB(32, 120, 32, 240),
      ),
    );
  }

  Future<void> _showFlagDialog() async {
    if (_isFlagDialogOpen) {
      return;
    }
    _isFlagDialogOpen = true;

    final AppStrings strings = AppStrings.of(context);
    try {
      final FlagSubmissionResult? submission = await Navigator.of(context).push<FlagSubmissionResult>(
        MaterialPageRoute<FlagSubmissionResult>(
          builder: (BuildContext context) => FlagSubmissionScreen(options: _flagOptions),
        ),
      );

      if (!mounted || submission == null) {
        return;
      }

      await widget.onSubmitFlag(submission.code, submission.reason);
      if (!mounted) {
        return;
      }

      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        SnackBar(content: Text(strings.tr('sendFlag', 'Send flag'))),
      );
    } catch (submitError) {
      if (!mounted) {
        return;
      }
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        SnackBar(
          content: Text(
            submitError.toString().replaceFirst('Exception: ', ''),
          ),
        ),
      );
    } finally {
      _isFlagDialogOpen = false;
    }
  }

  Future<void> _handleToggleLanguage() async {
    if (_isFlagDialogOpen) {
      await Navigator.of(context, rootNavigator: true).maybePop();
      _isFlagDialogOpen = false;
    }
    if (!mounted) {
      return;
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        widget.onToggleLanguage();
      }
    });
  }

  double _effectiveDistanceKm() {
    if (_route != null) {
      return _route!.distanceKm.toDouble();
    }
    final Position? current = _currentPosition;
    final TaskLocation? target = _activeTarget;
    if (current == null || target == null) {
      return 0;
    }
    return _distance.as(
      LengthUnit.Kilometer,
      LatLng(current.latitude, current.longitude),
      LatLng(target.latitude, target.longitude),
    );
  }

  int _effectiveEtaMinutes() {
    if (_route != null) {
      return _route!.etaMinutes;
    }
    final double distanceKm = _effectiveDistanceKm();
    if (distanceKm <= 0) {
      return 0;
    }
    final double currentSpeedKph = _currentPosition == null || !_currentPosition!.speed.isFinite
        ? 0
        : (_currentPosition!.speed * 3.6).clamp(0, 220);
    final double baselineSpeedKph = currentSpeedKph >= 20 ? currentSpeedKph : 55;
    return math.max(1, ((distanceKm / baselineSpeedKph) * 60).round());
  }

  String _formatEta(AppStrings strings) {
    final int totalMinutes = _effectiveEtaMinutes();
    if (totalMinutes <= 0) {
      return '--';
    }
    if (totalMinutes < 60) {
      return '${totalMinutes.clamp(1, 59)} ${strings.tr('minutesShort', 'min')}';
    }
    final int hours = totalMinutes ~/ 60;
    final int minutes = totalMinutes % 60;
    if (minutes == 0) {
      return '$hours ${strings.tr('hoursShort', 'hr')}';
    }
    return '$hours ${strings.tr('hoursShort', 'hr')} ${minutes.toString().padLeft(2, '0')} ${strings.tr('minutesShort', 'min')}';
  }

  String _formatDistance(AppStrings strings) {
    final double distanceKm = _effectiveDistanceKm();
    if (distanceKm <= 0) {
      return '--';
    }
    final String rounded = distanceKm >= 10 ? distanceKm.toStringAsFixed(0) : distanceKm.toStringAsFixed(1);
    return '$rounded ${strings.tr('km', 'km')}';
  }

  List<LatLng> _effectiveRoutePath() {
    final List<LatLng> routePath = _route?.path ?? <LatLng>[];
    if (routePath.isNotEmpty) {
      return routePath;
    }
    final Position? current = _currentPosition;
    final TaskLocation? target = _activeTarget;
    if (current == null || target == null) {
      return <LatLng>[];
    }
    return <LatLng>[
      LatLng(current.latitude, current.longitude),
      LatLng(target.latitude, target.longitude),
    ];
  }

  String _primaryActionLabel(AppStrings strings) {
    if (widget.assignment.status == AssignmentStatus.queued) {
      return strings.tr('queuedTaskLocked', 'Waiting for the current trip');
    }
    if (widget.assignment.status == AssignmentStatus.paused) {
      return strings.tr('resumeTask', 'Resume task');
    }
    switch (widget.assignment.currentStage) {
      case AssignmentStage.rigDown:
        return widget.assignment.status == AssignmentStatus.assigned
            ? strings.tr('acceptAndStart', 'Accept and start')
            : strings.tr('pickedUp', 'Picked up');
      case AssignmentStage.rigMove:
        return strings.tr('arrivedDestination', 'Arrived at destination');
      case AssignmentStage.rigUp:
        return strings.tr('completeTask', 'Complete task');
      case AssignmentStage.completed:
        return strings.tr('done', 'Done');
    }
  }

  String _routeTitle(AppStrings strings) {
    switch (widget.assignment.currentStage) {
      case AssignmentStage.rigDown:
        return strings.tr('routeToPickup', 'Route to pickup rig');
      case AssignmentStage.rigMove:
        return strings.tr('routeToDestination', 'Route to destination rig');
      case AssignmentStage.rigUp:
        return strings.tr('atDestination', 'At destination rig');
      case AssignmentStage.completed:
        return strings.tr('taskCompleted', 'Task completed');
    }
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final AppStrings strings = AppStrings.of(context);
    final Position? current = _currentPosition;
    final TaskLocation? target = _activeTarget;
    final bool canPause = widget.assignment.status == AssignmentStatus.accepted || widget.assignment.status == AssignmentStatus.active;
    final bool canResume = widget.assignment.status == AssignmentStatus.paused;
    final bool isQueuedTask = widget.assignment.status == AssignmentStatus.queued;
    final int speedKph = current == null || !current.speed.isFinite ? 0 : (current.speed * 3.6).clamp(0, 220).round();
    final String locationStatus = current == null
        ? strings.tr('gpsWaiting', 'Waiting for GPS')
        : 'GPS ${current.latitude.toStringAsFixed(5)}, ${current.longitude.toStringAsFixed(5)}';
    final LatLng center = current == null ? const LatLng(24.7136, 46.6753) : LatLng(current.latitude, current.longitude);
    final List<LatLng> routePath = _effectiveRoutePath();

    return Scaffold(
      body: Stack(
        children: <Widget>[
          Positioned.fill(
            child: _isLoading
                ? const Center(child: CircularProgressIndicator())
                : FlutterMap(
                    mapController: _mapController,
                    options: MapOptions(
                      initialCenter: center,
                      initialZoom: 13,
                      onMapReady: () {
                        _isMapReady = true;
                        final List<LatLng> path = _effectiveRoutePath();
                        if (path.isNotEmpty) {
                          _focusOnRoute(path);
                        } else {
                          _centerOnCurrentLocation();
                        }
                      },
                    ),
                    children: <Widget>[
                      TileLayer(
                        urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                        userAgentPackageName: 'com.example.rigsync_driver_app',
                      ),
                      if (routePath.isNotEmpty)
                        PolylineLayer(
                          polylines: <Polyline>[
                            Polyline(
                              points: routePath,
                              strokeWidth: 9,
                              color: const Color(0x6611161D),
                            ),
                            Polyline(
                              points: routePath,
                              strokeWidth: 5,
                              color: const Color(0xFFC6FF00),
                            ),
                          ],
                        ),
                      MarkerLayer(
                        markers: <Marker>[
                          if (target != null)
                            Marker(
                              point: LatLng(target.latitude, target.longitude),
                              width: 44,
                              height: 44,
                              child: const Icon(
                                Icons.location_on_rounded,
                                size: 38,
                                color: Color(0xFFFFD54F),
                              ),
                            ),
                          if (current != null)
                            Marker(
                              point: LatLng(current.latitude, current.longitude),
                              width: 26,
                              height: 26,
                              child: Transform.rotate(
                                angle: (current.heading.isFinite ? current.heading : 0) * (math.pi / 180),
                                child: const Icon(
                                  Icons.navigation_rounded,
                                  size: 22,
                                  color: Color(0xFF58D1FF),
                                ),
                              ),
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
                      const SizedBox(width: 8),
                      _LanguageToggleButton(
                        label: strings.isArabic ? 'EN' : 'AR',
                        onTap: () {
                          unawaited(_handleToggleLanguage());
                        },
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Container(
                          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                          decoration: BoxDecoration(
                            color: const Color(0xF011161D),
                            borderRadius: BorderRadius.circular(22),
                            border: Border.all(color: const Color(0x14FFFFFF)),
                          ),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: <Widget>[
                              Text(
                                _routeTitle(strings),
                                style: theme.textTheme.bodySmall?.copyWith(color: const Color(0xFFC6FF90)),
                              ),
                              const SizedBox(height: 2),
                              Text(
                                target?.label ?? widget.assignment.moveName,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: theme.textTheme.titleMedium?.copyWith(color: Colors.white, fontWeight: FontWeight.w700),
                              ),
                              const SizedBox(height: 2),
                              Text(
                                widget.assignment.tripLabel,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: theme.textTheme.bodySmall?.copyWith(color: Colors.white70),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
          Positioned(
            right: 16,
            top: 220,
            child: Column(
              children: <Widget>[
                _CircleActionButton(
                  icon: Icons.flag_outlined,
                  onTap: widget.isSubmitting ? null : _showFlagDialog,
                ),
                const SizedBox(height: 14),
                _CircleActionButton(
                  icon: Icons.my_location_rounded,
                  onTap: _centerOnCurrentLocation,
                ),
                const SizedBox(height: 14),
                _CircleActionButton(
                  icon: Icons.refresh_rounded,
                  onTap: () {
                    _loadRoute(force: true);
                  },
                ),
              ],
            ),
          ),
          if (_error != null)
            Positioned(
              left: 16,
              right: 72,
              bottom: 188,
              child: Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: const Color(0xEE241317),
                  borderRadius: BorderRadius.circular(18),
                ),
                child: Text(
                  _error!,
                  style: theme.textTheme.bodyMedium?.copyWith(color: const Color(0xFFFF9C9C)),
                ),
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
                  borderRadius: BorderRadius.vertical(top: Radius.circular(24), bottom: Radius.circular(24)),
                ),
                padding: const EdgeInsets.fromLTRB(16, 10, 16, 14),
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
                    const SizedBox(height: 8),
                    Text(
                      widget.assignment.loadCode.isNotEmpty
                          ? '${widget.assignment.loadCode} - #${widget.assignment.sequence}'
                          : '#${widget.assignment.sequence}',
                      style: theme.textTheme.bodyMedium?.copyWith(color: Colors.white70),
                    ),
                    if (widget.assignment.plannedTripCount > 0 || widget.assignment.tripNumber > 0) ...<Widget>[
                      const SizedBox(height: 4),
                      Text(
                        widget.assignment.plannedTripCount > 0
                            ? '${strings.tr('trip', 'Trip')} ${widget.assignment.tripNumber}/${widget.assignment.plannedTripCount}'
                            : '${strings.tr('trip', 'Trip')} ${widget.assignment.tripNumber}',
                        style: theme.textTheme.bodySmall?.copyWith(color: Colors.white38),
                      ),
                    ],
                    const SizedBox(height: 10),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      decoration: BoxDecoration(
                        color: const Color(0xFF11161D),
                        borderRadius: BorderRadius.circular(16),
                        border: Border.all(color: const Color(0x22FFFFFF)),
                      ),
                      child: Row(
                        children: <Widget>[
                          Expanded(
                            child: _TopMetric(
                              label: strings.tr('eta', 'ETA'),
                              value: _formatEta(strings),
                            ),
                          ),
                          Expanded(
                            child: _TopMetric(
                              label: strings.tr('distance', 'Distance'),
                              value: _formatDistance(strings),
                            ),
                          ),
                          Expanded(
                            child: _TopMetric(
                              label: strings.tr('speed', 'Speed'),
                              value: '$speedKph ${strings.tr('kmh', 'km/h')}',
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 12),
                    Row(
                      children: <Widget>[
                        Expanded(
                          child: OutlinedButton(
                            onPressed: widget.isSubmitting
                                ? null
                                : (canResume ? widget.onResume : (canPause ? widget.onPause : null)),
                            child: Text(
                              canResume
                                  ? strings.tr('resumeTask', 'Resume task')
                                  : strings.tr('pauseTask', 'Pause task'),
                            ),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          flex: 2,
                          child: ElevatedButton(
                            onPressed: widget.isSubmitting || isQueuedTask || widget.assignment.currentStage == AssignmentStage.completed
                                ? null
                                : () async {
                                    if (widget.assignment.currentStage == AssignmentStage.rigDown &&
                                        widget.assignment.status == AssignmentStatus.assigned) {
                                      await widget.onAccept();
                                      return;
                                    }
                                    await widget.onPrimaryAction(
                                      current == null ? null : _telemetryFrom(current),
                                    );
                                  },
                            child: Text(_primaryActionLabel(strings)),
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

class _TopMetric extends StatelessWidget {
  const _TopMetric({
    required this.label,
    required this.value,
  });

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(label, style: theme.textTheme.bodySmall),
        const SizedBox(height: 4),
        Text(
          value,
          style: theme.textTheme.titleSmall?.copyWith(color: Colors.white, fontWeight: FontWeight.w700),
        ),
      ],
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
      width: 52,
      height: 52,
      decoration: const BoxDecoration(
        color: Color(0xF6000000),
        shape: BoxShape.circle,
      ),
      child: IconButton(
        onPressed: onTap,
        icon: Icon(icon, color: Colors.white, size: 26),
      ),
    );
  }
}

class _LanguageToggleButton extends StatelessWidget {
  const _LanguageToggleButton({
    required this.label,
    this.onTap,
  });

  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 52,
      height: 52,
      decoration: const BoxDecoration(
        color: Color(0xF6000000),
        shape: BoxShape.circle,
      ),
      child: TextButton(
        onPressed: onTap,
        child: Text(
          label,
          style: Theme.of(context).textTheme.titleSmall?.copyWith(
                color: Colors.white,
                fontWeight: FontWeight.w700,
              ),
        ),
      ),
    );
  }
}




