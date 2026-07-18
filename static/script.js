document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const uploadSection = document.getElementById('upload-section');
    const editorSection = document.getElementById('editor-section');
    const metadataForm = document.getElementById('metadata-form');
    const backBtn = document.getElementById('back-btn');
    const saveBtn = document.getElementById('save-btn');
    const saveSpinner = document.getElementById('save-spinner');
    const btnText = document.querySelector('.btn-text');
    const searchInput = document.getElementById('search-input');
    
    let currentFileId = null;
    let originalMetadata = {};
    let formElements = []; // Store references for search

    // Drag and drop handlers
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover'), false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover'), false);
    });

    dropZone.addEventListener('drop', (e) => {
        const files = e.dataTransfer.files;
        if (files.length) handleFile(files[0]);
    });

    dropZone.addEventListener('click', () => fileInput.click());
    
    fileInput.addEventListener('change', function() {
        if (this.files.length) handleFile(this.files[0]);
    });

    function handleFile(file) {
        const formData = new FormData();
        formData.append('file', file);
        
        // UI Feedback (could add actual progress event here)
        dropZone.querySelector('.drop-text').textContent = 'Uploading...';
        
        fetch('/upload', {
            method: 'POST',
            body: formData
        })
        .then(response => {
            if (!response.ok) throw new Error('Upload failed');
            return response.json();
        })
        .then(data => {
            currentFileId = data.file_id;
            originalMetadata = data.metadata;
            renderMetadataForm(data.metadata);
            switchSection(uploadSection, editorSection);
            dropZone.querySelector('.drop-text').textContent = 'Drag & drop your image here';
        })
        .catch(error => {
            console.error('Error:', error);
            alert('Error uploading file. Please ensure exiftool is installed on the server.');
            dropZone.querySelector('.drop-text').textContent = 'Upload failed. Try again.';
        });
    }

    function renderMetadataForm(metadata) {
        metadataForm.innerHTML = '';
        formElements = [];
        
        // Exclude some large/binary fields generally not edited directly
        const excludedPrefixes = ['File:Directory', 'File:FileName', 'File:FilePermissions', 'EXIF:ThumbnailImage', 'Composite:', 'System:'];
        
        // Define commonly edited fields in order of priority
        const commonFields = [
            'EXIF:Artist', 'EXIF:Copyright', 'EXIF:ImageDescription', 'EXIF:UserComment',
            'EXIF:Make', 'EXIF:Model', 'EXIF:Software', 
            'EXIF:DateTimeOriginal', 'EXIF:CreateDate', 'EXIF:ModifyDate',
            'EXIF:GPSLatitude', 'EXIF:GPSLatitudeRef', 'EXIF:GPSLongitude', 'EXIF:GPSLongitudeRef', 'EXIF:GPSAltitude',
            'EXIF:LensModel', 'EXIF:LensMake',
            'EXIF:FNumber', 'EXIF:ExposureTime', 'EXIF:ISO'
        ];

        let entries = Object.entries(metadata).filter(([key, value]) => {
            if (excludedPrefixes.some(prefix => key.startsWith(prefix))) return false;
            if (typeof value === 'object' && value !== null) return false;
            if (typeof value === 'string' && value.includes('(Binary data')) return false;
            return true;
        });

        // Sort entries
        entries.sort((a, b) => {
            const indexA = commonFields.indexOf(a[0]);
            const indexB = commonFields.indexOf(b[0]);
            
            // Both are common fields
            if (indexA !== -1 && indexB !== -1) return indexA - indexB;
            // A is common, B is not
            if (indexA !== -1) return -1;
            // B is common, A is not
            if (indexB !== -1) return 1;
            
            // Neither are common, sort alphabetically
            return a[0].localeCompare(b[0]);
        });

        entries.forEach(([key, value]) => {
            const group = document.createElement('div');
            group.className = 'form-group';
            group.dataset.key = key.toLowerCase();
            
            const label = document.createElement('label');
            label.textContent = key;
            label.htmlFor = `input-${key}`;
            
            const input = document.createElement('input');
            input.type = 'text';
            input.id = `input-${key}`;
            input.dataset.key = key;
            input.value = value;
            
            group.appendChild(label);
            group.appendChild(input);
            metadataForm.appendChild(group);
            formElements.push(group);
        });
    }

    searchInput.addEventListener('input', (e) => {
        const term = e.target.value.toLowerCase();
        formElements.forEach(el => {
            if (el.dataset.key.includes(term)) {
                el.style.display = 'flex';
            } else {
                el.style.display = 'none';
            }
        });
    });

    backBtn.addEventListener('click', () => {
        switchSection(editorSection, uploadSection);
        fileInput.value = ''; // reset input
        searchInput.value = '';
    });

    saveBtn.addEventListener('click', () => {
        const modifications = {};
        let hasChanges = false;
        
        // Gather modified fields
        metadataForm.querySelectorAll('input').forEach(input => {
            const key = input.dataset.key;
            if (input.value !== String(originalMetadata[key])) {
                modifications[key] = input.value;
                hasChanges = true;
            }
        });
        
        if (!hasChanges) {
            alert('No metadata was changed.');
            return;
        }
        
        setLoading(true);
        
        fetch('/edit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                file_id: currentFileId,
                modifications: modifications
            })
        })
        .then(response => {
            if (!response.ok) throw new Error('Edit failed');
            return response.json();
        })
        .then(data => {
            if (data.success) {
                // Trigger download
                window.location.href = `/download/${currentFileId}`;
            }
        })
        .catch(error => {
            console.error('Error:', error);
            alert('Failed to save metadata.');
        })
        .finally(() => {
            setLoading(false);
        });
    });

    function switchSection(hideSection, showSection) {
        hideSection.classList.remove('active');
        setTimeout(() => {
            hideSection.classList.add('hidden');
            showSection.classList.remove('hidden');
            // small delay to allow display block to apply before animating opacity
            setTimeout(() => showSection.classList.add('active'), 50);
        }, 400); // match css transition
    }

    function setLoading(isLoading) {
        saveBtn.disabled = isLoading;
        if (isLoading) {
            btnText.classList.add('hidden');
            saveSpinner.classList.remove('hidden');
        } else {
            btnText.classList.remove('hidden');
            saveSpinner.classList.add('hidden');
        }
    }
});
