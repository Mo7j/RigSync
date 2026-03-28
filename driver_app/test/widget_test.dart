import 'package:flutter_test/flutter_test.dart';

import 'package:rigsync_driver_app/src/app_shell.dart';

void main() {
  testWidgets('shows login screen on launch', (WidgetTester tester) async {
    await tester.pumpWidget(const RigSyncDriverApp());

    expect(find.text('Driver login'), findsOneWidget);
    expect(find.text('Login'), findsOneWidget);
  });
}
