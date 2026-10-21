import re
original_s = '“fluid”'
suggestion_s = 'fluid'
orig_letters = re.sub(r'[^\w\s]', '', original_s).lower()
sugg_letters = re.sub(r'[^\w\s]', '', suggestion_s).lower()
print(f'Orig: {orig_letters}, Sugg: {sugg_letters}, Match: {orig_letters == sugg_letters}')
