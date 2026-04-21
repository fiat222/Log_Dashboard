import http.server
import subprocess
import threading
import os

class BackupHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == '/trigger':
            def run_backup():
                print("Manual backup triggered via API")
                subprocess.run(["/bin/bash", "/usr/local/bin/backup.sh"])
            
            # Run in a separate thread so the HTTP request returns immediately
            threading.Thread(target=run_backup).start()
            
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"status": "success", "message": "Backup started in background"}')
        else:
            self.send_response(404)
            self.end_headers()

def run(server_class=http.server.HTTPServer, handler_class=BackupHandler, port=8080):
    server_address = ('', port)
    httpd = server_class(server_address, handler_class)
    print(f"Backup trigger server running on port {port}...")
    httpd.serve_forever()

if __name__ == "__main__":
    run()
