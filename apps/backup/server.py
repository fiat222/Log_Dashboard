import http.server
import subprocess

class BackupHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == '/trigger':
            result = subprocess.run(
                ["/bin/bash", "/usr/local/bin/backup.sh"],
                capture_output=True,
                timeout=600,  # 10 min max
            )
            success = result.returncode == 0
            code = 200 if success else 500
            body = b'{"status":"success"}' if success else b'{"status":"failed"}'
            self.send_response(code)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(body)
            if not success:
                print(f"Backup failed: {result.stderr.decode(errors='replace')}")
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        print(f"{self.address_string()} - {format % args}")

def run(server_class=http.server.HTTPServer, handler_class=BackupHandler, port=8080):
    server_address = ('', port)
    httpd = server_class(server_address, handler_class)
    print(f"Backup trigger server running on port {port}...")
    httpd.serve_forever()

if __name__ == "__main__":
    run()
