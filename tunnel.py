import psycopg2
from sshtunnel import SSHTunnelForwarder

def connect():
    server = SSHTunnelForwarder(
        ('13.232.80.1', 22),
        ssh_username='ubuntu',
        ssh_pkey='ec2_key.pem',
        remote_bind_address=('127.0.0.1', 5432)
    )
    server.start()
    
    conn = psycopg2.connect(
        host='127.0.0.1',
        port=server.local_bind_port,
        user='ethosh',
        password='ethosh@123',
        database='qualilabs'
    )
    return server, conn

try:
    server, conn = connect()
    print('CONNECTED VIA SSH!')
    with conn.cursor() as cur:
        cur.execute("SELECT * FROM profiles WHERE email IN ('shree.sonar@ethosh.com', 'admin2011@ethosh.com')")
        print(cur.fetchall())
    conn.close()
    server.stop()
except Exception as e:
    print('FAILED:', e)
