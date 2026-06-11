# Repro notes

1. Open new-task screen
2. Type a title
3. Double-tap Save quickly (under ~300ms)
4. Two identical tasks appear in the list

Confirmed on iPhone 14 / iOS 19 and Pixel 8. Does not reproduce on slow devices where the first write resolves before the second tap registers — which is why it was missed in dev.
