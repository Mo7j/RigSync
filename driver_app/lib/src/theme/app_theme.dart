import 'package:flutter/material.dart';

ThemeData buildRigSyncTheme() {
  const Color bg = Color(0xFF07090D);
  const Color card = Color(0xFF11161D);
  const Color cardStrong = Color(0xFF171D26);
  const Color accent = Color(0xFFC6FF00);
  const Color text = Color(0xFFF2F7F4);
  const Color muted = Color(0xFF97A19D);

  final ColorScheme scheme = ColorScheme.dark(
    primary: accent,
    secondary: accent,
    surface: card,
    onSurface: text,
    onPrimary: Colors.black,
    error: const Color(0xFFFF7B7B),
  );

  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: bg,
    canvasColor: bg,
    fontFamily: 'Roboto',
    textTheme: const TextTheme(
      displaySmall: TextStyle(
        color: text,
        fontSize: 34,
        fontWeight: FontWeight.w700,
        height: 1.05,
      ),
      headlineMedium: TextStyle(
        color: text,
        fontSize: 24,
        fontWeight: FontWeight.w700,
      ),
      titleLarge: TextStyle(
        color: text,
        fontSize: 18,
        fontWeight: FontWeight.w700,
      ),
      titleMedium: TextStyle(
        color: text,
        fontSize: 15,
        fontWeight: FontWeight.w600,
      ),
      bodyLarge: TextStyle(
        color: text,
        fontSize: 15,
        height: 1.45,
      ),
      bodyMedium: TextStyle(
        color: muted,
        fontSize: 13,
        height: 1.4,
      ),
      labelLarge: TextStyle(
        color: Colors.black,
        fontWeight: FontWeight.w700,
      ),
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      foregroundColor: text,
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: cardStrong,
      hintStyle: const TextStyle(color: Color(0xFF6C7674)),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(20),
        borderSide: BorderSide.none,
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(20),
        borderSide: const BorderSide(color: Color(0x1AFFFFFF)),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(20),
        borderSide: const BorderSide(color: accent, width: 1.2),
      ),
      contentPadding: const EdgeInsets.symmetric(horizontal: 18, vertical: 18),
    ),
    cardTheme: CardThemeData(
      color: card,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(26),
        side: const BorderSide(color: Color(0x12FFFFFF)),
      ),
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        backgroundColor: accent,
        foregroundColor: Colors.black,
        minimumSize: const Size.fromHeight(58),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(20),
        ),
        textStyle: const TextStyle(
          fontSize: 15,
          fontWeight: FontWeight.w700,
        ),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: text,
        minimumSize: const Size.fromHeight(54),
        side: const BorderSide(color: Color(0x1FFFFFFF)),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(18),
        ),
      ),
    ),
  );
}
