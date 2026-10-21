import fitz

doc = fitz.open('test_out2.pdf') # or any pdf that has text
page = doc[0]
words = page.get_text('words')
print(words[:10])
