import sys
text = open(r'scripts/test-desktop.ps1', 'rb').read().decode('utf-8-sig')
lines = text.splitlines()
print('total lines', len(lines))
for i, l in enumerate(lines, 1):
    n = l.count('"')
    smart = [c for c in l if ord(c) in (0x201C, 0x201D, 0x2018, 0x2019)]
    if n % 2 == 1 or smart:
        print(f'L{i}: dquotes={n} smart={smart!r} | {l}')
