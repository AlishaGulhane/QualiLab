from puttykeys import PPKKey

key = PPKKey.from_file('Ethosh QC Python 1 (1).ppk')
with open('ec2_key.pem', 'w') as f:
    f.write(key.to_openssh())
