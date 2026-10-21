import re

text = 'Hi my name is alisha. i study at VIT. can i borrow  your charger. Can we put the dog on the fence. chocolates are harmeful. nailpaints smell so strong i almost get an headache.'

issues = []

for match in re.finditer(r'(?:^|[\.\?\!]\s+)([a-z])', text):
    start_idx = match.start(1)
    word_match = re.match(r'[a-z]+', text[start_idx:])
    if word_match:
        issues.append(word_match.group(0))

for match in re.finditer(r'(?<![A-Za-z])(i)(?![A-Za-z])', text):
    issues.append(match.group(1))

print(issues)
