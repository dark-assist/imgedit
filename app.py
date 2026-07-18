import os
import uuid
import json
import tempfile
import sys
import platform
import subprocess
import stat
from flask import Flask, request, jsonify, send_from_directory, make_response, send_file
import redis
import exiftool
from werkzeug.utils import secure_filename

app = Flask(__name__, static_folder='static', static_url_path='')

# Configure Redis (Fallback to in-memory dict for local testing if REDIS_URL not set)
REDIS_URL = os.environ.get('REDIS_URL')
if REDIS_URL:
    cache = redis.from_url(REDIS_URL)
else:
    # Dummy cache for local dev without redis
    class DummyCache:
        def __init__(self):
            self.data = {}
        def setex(self, key, time, value):
            self.data[key] = value
        def get(self, key):
            return self.data.get(key)
    cache = DummyCache()

UPLOAD_FOLDER = tempfile.gettempdir()
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER

def get_cookie_id():
    cookie_id = request.cookies.get('session_id')
    if not cookie_id:
        cookie_id = str(uuid.uuid4())
    return cookie_id

@app.route('/sysinfo')
def sysinfo():
    return jsonify({
        'system': platform.system(),
        'release': platform.release(),
        'version': platform.version(),
        'machine': platform.machine(),
        'architecture': platform.architecture(),
        'python_version': sys.version
    })

@app.route('/debug-env')
def debug_env():
    exiftool_path = os.path.join(app.root_path, 'Image-ExifTool-13.59', 'exiftool')
    
    # Check 1: Does the file exist?
    exists = os.path.exists(exiftool_path)
    
    # Check 2: Is it executable?
    is_executable = False
    if exists:
        is_executable = os.access(exiftool_path, os.X_OK)
        
    # Check 3: Is Perl installed?
    perl_version = "Not installed or failed"
    try:
        perl_version = subprocess.check_output(['perl', '-v'], stderr=subprocess.STDOUT).decode('utf-8').split('\n')[1]
    except Exception as e:
        perl_version = str(e)
        
    # Check 4: Try running exiftool directly
    direct_run = "Failed"
    try:
        if exists:
            direct_run = subprocess.check_output([exiftool_path, '-ver'], stderr=subprocess.STDOUT).decode('utf-8').strip()
    except Exception as e:
        direct_run = str(e)

    return jsonify({
        'exiftool_exists': exists,
        'exiftool_executable': is_executable,
        'perl_check': perl_version,
        'exiftool_direct_run': direct_run
    })

@app.route('/')
def index():
    response = make_response(send_from_directory('static', 'index.html'))
    if not request.cookies.get('session_id'):
        response.set_cookie('session_id', str(uuid.uuid4()), max_age=43200) # 12 hours
    return response

@app.route('/upload', methods=['POST'])
def upload_file():
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400
    
    filename = secure_filename(file.filename)
    file_id = str(uuid.uuid4())
    ext = os.path.splitext(filename)[1]
    save_path = os.path.join(app.config['UPLOAD_FOLDER'], f"{file_id}{ext}")
    file.save(save_path)
    
    exiftool_path = os.path.join(app.root_path, 'Image-ExifTool-13.59', 'exiftool')
    try:
        with exiftool.ExifToolHelper(executable=exiftool_path) as et:
            metadata = et.get_metadata(save_path)[0]
            
        # Security: Remove sensitive server paths from metadata
        keys_to_remove = ['SourceFile']
        for key in list(metadata.keys()):
            if key in keys_to_remove or key.startswith('File:Directory') or key.startswith('File:FileName') or key.startswith('File:FilePermissions'):
                del metadata[key]
                
    except Exception as e:
        return jsonify({'error': f'Failed to read metadata: {str(e)}'}), 500
        
    session_id = get_cookie_id()
    # Cache file path and filename against session + file_id for 12h (43200 seconds)
    cache_data = json.dumps({'path': save_path, 'filename': filename})
    cache.setex(f"session:{session_id}:file:{file_id}", 43200, cache_data)
    
    response = make_response(jsonify({'file_id': file_id, 'metadata': metadata}))
    if not request.cookies.get('session_id'):
        response.set_cookie('session_id', session_id, max_age=43200)
    return response

@app.route('/edit', methods=['POST'])
def edit_metadata():
    session_id = request.cookies.get('session_id')
    data = request.json
    file_id = data.get('file_id')
    modifications = data.get('modifications')
    
    if not session_id or not file_id:
        return jsonify({'error': 'Missing session or file ID'}), 400
        
    cache_data = cache.get(f"session:{session_id}:file:{file_id}")
    if not cache_data:
        return jsonify({'error': 'File not found or session expired'}), 404
        
    file_info = json.loads(cache_data)
    file_path = file_info['path']
    
    exiftool_path = os.path.join(app.root_path, 'Image-ExifTool-13.59', 'exiftool')
    try:
        with exiftool.ExifToolHelper(executable=exiftool_path) as et:
            # Note: exiftool expects a dict of tags to set
            et.set_tags(file_path, tags=modifications)
    except Exception as e:
        return jsonify({'error': f'Failed to write metadata: {str(e)}'}), 500
        
    return jsonify({'success': True})

@app.route('/download/<file_id>', methods=['GET'])
def download_file(file_id):
    session_id = request.cookies.get('session_id')
    if not session_id:
        return jsonify({'error': 'Unauthorized'}), 401
        
    cache_data = cache.get(f"session:{session_id}:file:{file_id}")
    if not cache_data:
        return jsonify({'error': 'File not found or session expired'}), 404
        
    file_info = json.loads(cache_data)
    # Return the file, forcing download with original filename
    return send_file(file_info['path'], as_attachment=True, download_name=file_info['filename'])

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
