let currentSessionId = null;
let currentTerminal = null;
let sessions = {};
let outputPollingInterval = null;
let fitAddon = null;
let currentTool = null;
let currentPath = '/';
let isLoadingFiles = false;
let savedConnectionGroups = [];
let expandedBookmarkNodes = new Set();
let bookmarkDropdownSeq = 0;

/** Sessão com foco de teclado (Alt+Tab / clique na barra); input SSH só vai para esta. */
let focusedSessionId = null;
/** Layout das secções de terminal entre si: só uma sessão visível ou colunas ou empilhado. */
let sessionViewLayout = 'single';
const SESSION_VIEW_LAYOUT_KEY = 'prismssh.sessionViewLayout';

/** Rótulo exibido na árvore de bookmarks (Device Name salvos no perfil). */
function getBookmarkDisplayName(conn) {
    if (!conn) return '';
    const raw = conn.name != null ? String(conn.name).trim() : '';
    if (raw) return raw;
    if (conn.username != null && conn.hostname != null) {
        return `${conn.username}@${conn.hostname}`;
    }
    return (conn.key && String(conn.key)) || 'Conexão';
}

function closeBookmarkOptionMenus() {
    document.querySelectorAll('.bookmark-dropdown.open').forEach((el) => {
        el.classList.remove('open');
        clearBookmarkDropdownLayout(el);
        syncBookmarkGearAria(el);
    });
}

function syncBookmarkGearAria(dropdownEl) {
    if (!dropdownEl || !dropdownEl.closest) return;
    const wrap = dropdownEl.closest('.bookmark-gear-wrap');
    const btn = wrap && wrap.querySelector('.bookmark-gear-btn');
    if (!btn) return;
    btn.setAttribute('aria-expanded', dropdownEl.classList.contains('open') ? 'true' : 'false');
}

/** Remove inline position usado quando o menu está aberto (viewport). */
function clearBookmarkDropdownLayout(dd) {
    if (!dd || !dd.style) return;
    dd.style.position = '';
    dd.style.left = '';
    dd.style.right = '';
    dd.style.top = '';
    dd.style.bottom = '';
    dd.style.width = '';
    dd.style.zIndex = '';
}

/** Posição fixa alinhada à engrenagem para não ser cortada pelo overflow da sidebar. */
function anchorBookmarkDropdown(dd, anchorBtn) {
    if (!dd || !anchorBtn) return;
    const MENU_WIDTH = 184;
    const gutter = 6;
    const br = anchorBtn.getBoundingClientRect();
    dd.style.position = 'fixed';
    dd.style.zIndex = '6100';
    let left = Math.round(br.right - MENU_WIDTH);
    left = Math.max(gutter, Math.min(left, window.innerWidth - MENU_WIDTH - gutter));
    dd.style.left = `${left}px`;
    dd.style.right = 'auto';
    dd.style.top = `${Math.round(br.bottom + gutter)}px`;
    dd.style.bottom = 'auto';
    dd.style.width = `${Math.round(MENU_WIDTH)}px`;
}

function toggleBookmarkDropdown(event, menuId) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    const el = document.getElementById(menuId);
    if (!el) return;

    document.querySelectorAll('.bookmark-dropdown.open').forEach((d) => {
        if (d.id !== menuId) {
            d.classList.remove('open');
            clearBookmarkDropdownLayout(d);
            syncBookmarkGearAria(d);
        }
    });

    const anchorBtn = el.closest('.bookmark-gear-wrap')?.querySelector('.bookmark-gear-btn');
    const willOpen = !el.classList.contains('open');
    if (willOpen) {
        el.classList.add('open');
        anchorBookmarkDropdown(el, anchorBtn);
    } else {
        el.classList.remove('open');
        clearBookmarkDropdownLayout(el);
    }
    syncBookmarkGearAria(el);
}

async function editSavedBookmark(key) {
    closeBookmarkOptionMenus();
    await loadConnection(key);
    const hn = document.getElementById('hostname');
    if (hn) {
        try {
            hn.focus();
            hn.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } catch (err) {
            /* ignore scroll errors in embed */
        }
    }
}

// Optimistic typing state
let pendingEchoBuffer = [];
const ECHO_TIMEOUT_MS = 2000;

function isOptimisticChar(data) {
    if (data.length !== 1) return false;
    const code = data.charCodeAt(0);
    if (code === 127) return true; // backspace
    return code >= 32;
}

function stripPredictedEchoes(output) {
    if (pendingEchoBuffer.length === 0) return output;

    const now = Date.now();

    while (pendingEchoBuffer.length > 0 && now - pendingEchoBuffer[0].time > ECHO_TIMEOUT_MS) {
        pendingEchoBuffer.shift();
    }

    if (pendingEchoBuffer.length === 0) return output;

    let outputPos = 0;
    let matched = 0;

    while (matched < pendingEchoBuffer.length && outputPos < output.length) {
        if (output[outputPos] === pendingEchoBuffer[matched].char) {
            outputPos++;
            matched++;
        } else {
            break;
        }
    }

    if (matched > 0) {
        pendingEchoBuffer.splice(0, matched);
    }

    return output.substring(outputPos);
}

/** Eco otimista apenas na sessão com foco de teclado. */
function stripPredictedEchoesFiltered(sessionId, output) {
    if (sessionId !== focusedSessionId) return output;
    return stripPredictedEchoes(output);
}

function getSessionPaneTitle(sessionId) {
    const s = sessions[sessionId];
    if (!s) return '';
    if (s.label != null && String(s.label).trim()) return String(s.label).trim();
    if (s.username != null && s.hostname != null) return `${s.username}@${s.hostname}`;
    const part = sessionId.split('_')[1];
    return part ? `Sessão ${part}` : sessionId;
}

function getConnectedSessionsOrderedForSplit() {
    return Object.keys(sessions).filter((id) => sessions[id] && sessions[id].connected !== false && sessions[id].terminal);
}

function cycleTerminalPaneFocus(delta) {
    const ids = getConnectedSessionsOrderedForSplit();
    if (ids.length < 2) return;
    let nextIdx = ids.indexOf(focusedSessionId);
    if (nextIdx < 0) nextIdx = 0;
    nextIdx = (nextIdx + delta + ids.length) % ids.length;
    switchToSession(ids[nextIdx]);
}

function readStoredSessionViewLayout() {
    try {
        const v = localStorage.getItem(SESSION_VIEW_LAYOUT_KEY);
        return v === 'split-h' || v === 'split-v' || v === 'single' ? v : 'single';
    } catch (e) {
        return 'single';
    }
}

function updateSessionSplitToolbarButtons() {
    const map = {
        single: 'btnSessionLayoutSingle',
        'split-h': 'btnSessionLayoutSplitH',
        'split-v': 'btnSessionLayoutSplitV'
    };
    Object.keys(map).forEach((mode) => {
        const el = document.getElementById(map[mode]);
        if (el) el.classList.toggle('active', sessionViewLayout === mode);
    });
}

function applyTerminalPaneDOMVisibility() {
    Object.keys(sessions).forEach((sid) => {
        const s = sessions[sid];
        if (!s?.paneSection) return;
        if (sessionViewLayout === 'single') {
            s.paneSection.classList.toggle('terminal-pane-visible', sid === focusedSessionId);
        } else {
            const show = !!s.terminal && s.connected !== false;
            s.paneSection.classList.toggle('terminal-pane-visible', show);
        }
    });

    Object.keys(sessions).forEach((sid) => {
        const s = sessions[sid];
        if (!s?.paneHeaderEl) return;
        s.paneHeaderEl.classList.toggle('terminal-pane-focused', sid === focusedSessionId);
    });
}

function resizeVisibleSessionsCalculators() {
    Object.keys(sessions).forEach((sid) => {
        const s = sessions[sid];
        if (!s?.calculateSize) return;
        if (sessionViewLayout === 'single' && sid !== focusedSessionId) return;
        if (s.connected === false) return;
        s.calculateSize();
    });
}

function notifyTerminalViewportResizeAll() {
    [80, 200, 400].forEach((ms) => {
        setTimeout(() => resizeVisibleSessionsCalculators(), ms);
    });
}

function applySessionPaneLayoutClasses() {
    const root = document.getElementById('terminalWrapper');
    if (!root) return;
    root.classList.remove(
        'terminal-session-layout-single',
        'terminal-session-layout-split-h',
        'terminal-session-layout-split-v'
    );
    if (sessionViewLayout === 'single') root.classList.add('terminal-session-layout-single');
    else if (sessionViewLayout === 'split-h') root.classList.add('terminal-session-layout-split-h');
    else root.classList.add('terminal-session-layout-split-v');
    updateSessionSplitToolbarButtons();
    applyTerminalPaneDOMVisibility();
}

function setSessionViewLayout(mode) {
    if (!['single', 'split-h', 'split-v'].includes(mode)) return;
    sessionViewLayout = mode;
    try {
        localStorage.setItem(SESSION_VIEW_LAYOUT_KEY, sessionViewLayout);
    } catch (e) {
        /* ignore */
    }
    applySessionPaneLayoutClasses();
    notifyTerminalViewportResizeAll();
}

function initSessionViewLayout() {
    sessionViewLayout = readStoredSessionViewLayout();
    applySessionPaneLayoutClasses();
}

function installSessionPaneKeyboardCycle() {
    if (window.__prismsshSessionPaneShortcuts) return;
    window.__prismsshSessionPaneShortcuts = true;
    window.addEventListener(
        'keydown',
        (e) => {
            if (sessionViewLayout === 'single') return;
            const ts = document.getElementById('terminalWrapper');
            if (!ts || ts.style.display === 'none') return;
            const ids = getConnectedSessionsOrderedForSplit();
            if (ids.length < 2) return;

            const key = e.key;
            const code = e.code;

            if (e.altKey && key === 'Tab') {
                e.preventDefault();
                cycleTerminalPaneFocus(e.shiftKey ? -1 : 1);
                return;
            }

            if (e.ctrlKey && !e.metaKey && !e.altKey && (code === 'PageDown' || code === 'PageUp')) {
                e.preventDefault();
                cycleTerminalPaneFocus(code === 'PageDown' ? 1 : -1);
            }
        },
        true
    );
}

// Tool panel functions
function openTool(toolName) {
    // Check if we have an active session
    if (!currentSessionId || !sessions[currentSessionId]) {
        alert('Please connect to a server first');
        return;
    }
    
    // Close current tool if clicking the same icon
    if (currentTool === toolName) {
        closeToolPanel();
        return;
    }
    
    // Reset all tool icons
    document.querySelectorAll('.tool-icon').forEach(icon => {
        icon.classList.remove('active');
    });
    
    // Hide all tool panels
    document.querySelectorAll('.tool-panel').forEach(panel => {
        panel.classList.remove('active');
    });
    
    // Open the selected tool
    currentTool = toolName;
    document.getElementById(toolName + 'Icon').classList.add('active');
    document.getElementById(toolName + 'Panel').classList.add('active');
    document.getElementById('rightSidebar').classList.add('open');
    
    // Initialize tool based on type
    if (toolName === 'sftp') {
        initializeSFTP();
    } else if (toolName === 'monitor') {
        initializeSystemMonitor();
    } else if (toolName === 'portForward') {
        initializePortForwarding();
    }
    
    // Resize terminals after sidebar opens (todas as sessões visíveis no modo split)
    setTimeout(() => notifyTerminalViewportResize(), 350);
}

function closeToolPanel() {
    currentTool = null;
    document.getElementById('rightSidebar').classList.remove('open');
    document.querySelectorAll('.tool-icon').forEach(icon => {
        icon.classList.remove('active');
    });
    document.querySelectorAll('.tool-panel').forEach(panel => {
        panel.classList.remove('active');
    });
    
    setTimeout(() => notifyTerminalViewportResize(), 350);
}

let workspaceMaximized = false;

function notifyTerminalViewportResize() {
    notifyTerminalViewportResizeAll();
}

function applyTerminalWorkspaceDOM() {
    const app = document.querySelector('.app');
    const content = document.getElementById('contentArea');
    const iconMax = document.getElementById('iconMaximize');
    const iconRest = document.getElementById('iconRestore');
    const toggleMaxBtn = document.getElementById('btnLayoutToggleMax');

    if (!app || !content) return;

    // Split de workspace (terminal vs ferramentas) foi removido da UI.
    // Aqui controlamos apenas maximizar/restaurar; o split ativo é entre terminais.
    content.classList.remove('terminal-split-horizontal', 'terminal-split-vertical');

    if (workspaceMaximized) {
        app.classList.add('terminal-layout-max');
    } else {
        app.classList.remove('terminal-layout-max');
    }

    if (toggleMaxBtn) {
        toggleMaxBtn.classList.toggle('active', workspaceMaximized);
        toggleMaxBtn.setAttribute(
            'title',
            workspaceMaximized
                ? 'Restaurar layout'
                : 'Maximizar terminal'
        );
    }
    if (iconMax && iconRest) {
        iconMax.style.display = workspaceMaximized ? 'none' : 'block';
        iconRest.style.display = workspaceMaximized ? 'block' : 'none';
    }
}

function toggleTerminalMaximized() {
    workspaceMaximized = !workspaceMaximized;
    applyTerminalWorkspaceDOM();
    notifyTerminalViewportResize();
}

function initTerminalWorkspaceLayout() {
    workspaceMaximized = false;
    applyTerminalWorkspaceDOM();
}

// SFTP Functions
async function initializeSFTP() {
    currentPath = '/home/' + sessions[currentSessionId].username;
    document.getElementById('currentPath').textContent = escapeHtml(currentPath);
    await listFiles(currentPath);
}

async function listFiles(path) {
    // Prevent multiple simultaneous requests
    if (isLoadingFiles) {
        console.log('Already loading files, please wait...');
        return;
    }
    
    isLoadingFiles = true;
    const fileList = document.getElementById('fileList');
    const loadingIndicator = document.getElementById('fileBrowserLoading');
    
    // Show loading state
    fileList.classList.add('loading');
    loadingIndicator.classList.add('active');
    
    try {
        const result = JSON.parse(
            await window.pywebview.api.list_directory(currentSessionId, path)
        );
        
        if (!result.success) {
            console.error('Failed to list directory:', result.error);
            fileList.innerHTML = '<div class="empty-message">Error loading files</div>';
            return;
        }
        
        fileList.innerHTML = '';
        
        // Add parent directory if not at root
        if (path !== '/') {
            const parentItem = document.createElement('div');
            parentItem.className = 'file-item';
            parentItem.innerHTML = `
                <svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
                <span class="file-name">..</span>
                <span class="file-size">-</span>
                <span class="file-date">-</span>
            `;
            parentItem.ondblclick = () => {
                if (!isLoadingFiles) navigateUp();
            };
            parentItem.onclick = () => selectFile(parentItem);
            fileList.appendChild(parentItem);
        }
        
        // Add files and directories
        result.files.forEach(file => {
            const item = document.createElement('div');
            item.className = 'file-item';
            item.setAttribute('data-filename', file.name);
            item.setAttribute('data-filetype', file.type);
            item.innerHTML = `
                <svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    ${file.type === 'directory' ? 
                        '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>' :
                        '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'
                    }
                </svg>
                <span class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
                <span class="file-size">${escapeHtml(file.size)}</span>
                <span class="file-date">${escapeHtml(file.date)}</span>
            `;
            
            if (file.type === 'directory') {
                item.ondblclick = () => {
                    if (!isLoadingFiles) navigateToFolder(file.name);
                };
            } else {
                item.ondblclick = () => {
                    if (!isLoadingFiles) downloadFile(file.name);
                };
            }
            
            item.onclick = () => selectFile(item);
            
            // Add right-click context menu
            item.oncontextmenu = (e) => {
                e.preventDefault();
                showContextMenu(e, item);
            };
            
            fileList.appendChild(item);
        });
        
        // Scroll to top after loading
        fileList.scrollTop = 0;
        
    } catch (error) {
        console.error('Error listing files:', error);
        fileList.innerHTML = '<div class="empty-message">Error loading files</div>';
    } finally {
        // Hide loading state
        isLoadingFiles = false;
        fileList.classList.remove('loading');
        loadingIndicator.classList.remove('active');
    }
}

function selectFile(element) {
    document.querySelectorAll('.file-item').forEach(item => {
        item.classList.remove('selected');
    });
    element.classList.add('selected');
}

function navigateUp() {
    if (isLoadingFiles) return;
    
    const parts = currentPath.split('/').filter(p => p);
    parts.pop();
    currentPath = '/' + parts.join('/');
    if (currentPath === '/') currentPath = '/';
    document.getElementById('currentPath').textContent = escapeHtml(currentPath);
    listFiles(currentPath);
}

function navigateToFolder(folderName) {
    if (isLoadingFiles) return;
    
    currentPath = currentPath.endsWith('/') ? 
        currentPath + folderName : 
        currentPath + '/' + folderName;
    document.getElementById('currentPath').textContent = escapeHtml(currentPath);
    listFiles(currentPath);
}

function refreshFiles() {
    if (isLoadingFiles) return;
    listFiles(currentPath);
}

function createNewFolder() {
    const folderName = prompt('Enter folder name:');
    if (folderName) {
        const fullPath = currentPath.endsWith('/') ? 
            currentPath + folderName : 
            currentPath + '/' + folderName;
        
        window.pywebview.api.create_directory(currentSessionId, fullPath).then(result => {
            const res = JSON.parse(result);
            if (res.success) {
                refreshFiles();
            } else {
                alert('Failed to create folder');
            }
        });
    }
}

async function downloadFile(fileName) {
    const remotePath = currentPath.endsWith('/') ? 
        currentPath + fileName : 
        currentPath + '/' + fileName;
    
    // For now, just log - you'd need to implement file save dialog
    console.log('Downloading:', remotePath);
    alert('File download functionality will be implemented with file save dialog');
}

function selectFiles() {
    document.getElementById('fileInput').click();
}

async function handleFileSelect(event) {
    const files = event.target.files;
    if (files.length > 0) {
        await uploadFiles(Array.from(files));
        // Clear the input so the same file can be selected again
        event.target.value = '';
    }
}

// Format bytes to human readable string
function formatBytes(bytes, decimals = 1) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
}

// Generate unique upload ID
function generateUploadId() {
    return 'upload_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Add File objects to upload queue (from Browse button)
async function uploadFiles(files) {
    if (!currentSessionId || !sessions[currentSessionId]) {
        alert('Please connect to a server first');
        return;
    }

    // Read files as base64 and add to queue
    for (const file of files) {
        const remotePath = currentPath.endsWith('/') ?
            currentPath + file.name :
            currentPath + '/' + file.name;
        const fileContent = await readFileAsBase64(file);
        uploadQueue.push({ fileContent, remotePath, fileName: file.name, isBase64: true });
    }

    console.log(`Added ${files.length} files to queue. Queue size: ${uploadQueue.length}`);

    if (!isProcessingUploads) {
        processUploadQueue();
    }
}

function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            // Remove the data:*;base64, prefix
            const base64 = reader.result.split(',')[1];
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// Upload queue system
let uploadQueue = [];
let isProcessingUploads = false;

// Add files to upload queue
function uploadFilesFromPaths(filePaths) {
    if (!currentSessionId || !sessions[currentSessionId]) {
        alert('Please connect to a server first');
        return;
    }

    // Add to queue
    for (const localPath of filePaths) {
        const fileName = localPath.split('/').pop();
        const remotePath = currentPath.endsWith('/') ?
            currentPath + fileName :
            currentPath + '/' + fileName;
        uploadQueue.push({ localPath, remotePath, fileName });
    }

    console.log(`Added ${filePaths.length} files to queue. Queue size: ${uploadQueue.length}`);

    // Start processing if not already
    if (!isProcessingUploads) {
        processUploadQueue();
    }
}

// Process upload queue
async function processUploadQueue() {
    if (isProcessingUploads || uploadQueue.length === 0) return;

    isProcessingUploads = true;

    const progressDiv = document.getElementById('uploadProgress');
    const statusText = document.getElementById('uploadStatusText');
    const uploadBar = document.getElementById('uploadBar');
    const uploadBytes = document.getElementById('uploadBytes');
    const uploadSpeed = document.getElementById('uploadSpeed');

    progressDiv.style.display = 'block';

    let uploadedCount = 0;
    let failedCount = 0;

    while (uploadQueue.length > 0) {
        const item = uploadQueue.shift();
        const { remotePath, fileName } = item;
        const queueRemaining = uploadQueue.length;

        statusText.textContent = queueRemaining > 0
            ? `Uploading ${fileName} (${queueRemaining} queued)...`
            : `Uploading ${fileName}...`;

        const uploadId = generateUploadId();

        try {
            let startResult;
            if (item.isBase64) {
                // Browse button upload (base64 content)
                startResult = await window.pywebview.api.start_upload_with_progress(
                    currentSessionId,
                    item.fileContent,
                    remotePath,
                    uploadId
                );
            } else {
                // Drag-drop upload (local path)
                startResult = await window.pywebview.api.upload_from_path_with_progress(
                    currentSessionId,
                    item.localPath,
                    remotePath,
                    uploadId
                );
            }

            const startResponse = JSON.parse(startResult);
            if (!startResponse.success) {
                console.error('Failed to start upload:', fileName, startResponse.error);
                failedCount++;
                continue;
            }

            // Poll for progress
            let completed = false;
            let lastBytes = 0;
            let lastTime = Date.now();

            while (!completed) {
                await new Promise(resolve => setTimeout(resolve, 100));

                const progressResult = await window.pywebview.api.get_upload_progress(
                    currentSessionId,
                    uploadId
                );
                const progress = JSON.parse(progressResult);

                if (progress.status === 'uploading' || progress.status === 'starting') {
                    uploadBar.style.width = `${progress.percentage}%`;
                    uploadBytes.textContent = `${formatBytes(progress.uploaded)} / ${formatBytes(progress.total)}`;

                    const now = Date.now();
                    const timeDiff = (now - lastTime) / 1000;
                    if (timeDiff >= 0.5) {
                        const bytesDiff = progress.uploaded - lastBytes;
                        const speed = bytesDiff / timeDiff;
                        uploadSpeed.textContent = speed > 0 ? `${formatBytes(speed)}/s` : '';
                        lastBytes = progress.uploaded;
                        lastTime = now;
                    }

                    const queueNow = uploadQueue.length;
                    statusText.textContent = queueNow > 0
                        ? `Uploading ${fileName} (${queueNow} queued)...`
                        : `Uploading ${fileName}...`;

                } else if (progress.status === 'completed') {
                    uploadBar.style.width = '100%';
                    uploadBytes.textContent = `${formatBytes(progress.total)} / ${formatBytes(progress.total)}`;
                    uploadSpeed.textContent = '';
                    uploadedCount++;
                    completed = true;
                    console.log('Successfully uploaded:', fileName);
                } else if (progress.status === 'error' || progress.status === 'cancelled') {
                    completed = true;
                    failedCount++;
                    console.error('Upload failed:', fileName, progress.error || progress.status);
                } else if (progress.status === 'unknown') {
                    completed = true;
                    uploadedCount++;
                }
            }

            await window.pywebview.api.clear_upload_progress(currentSessionId, uploadId);
            uploadBar.style.width = '0%';

        } catch (error) {
            console.error('Upload error for', fileName, error);
            failedCount++;
        }
    }

    console.log(`Upload complete: ${uploadedCount} succeeded, ${failedCount} failed`);
    statusText.textContent = failedCount > 0
        ? `Done: ${uploadedCount} uploaded, ${failedCount} failed`
        : `Uploaded ${uploadedCount} file${uploadedCount !== 1 ? 's' : ''}`;

    await listFiles(currentPath);

    isProcessingUploads = false;

    setTimeout(() => {
        if (!isProcessingUploads && uploadQueue.length === 0) {
            progressDiv.style.display = 'none';
            uploadBar.style.width = '0%';
            uploadBytes.textContent = '';
            uploadSpeed.textContent = '';
        }
    }, 2000);
}

// Handle native file drop from pywebview (receives full file paths)
async function handleNativeFileDrop(filePaths) {
    console.log('Native file drop received:', filePaths);
    if (filePaths && filePaths.length > 0) {
        await uploadFilesFromPaths(filePaths);
    }
}

// Drag and drop support
const setupDragDrop = () => {
    const uploadArea = document.getElementById('uploadArea');
    if (!uploadArea) {
        console.error('uploadArea element not found!');
        return;
    }
    console.log('Setting up drag and drop on uploadArea');

    // Prevent browser from opening files when dropped anywhere on the page
    document.addEventListener('dragover', (e) => {
        e.preventDefault();
    });
    document.addEventListener('drop', (e) => {
        console.log('Document drop event - preventing default');
        e.preventDefault();
    });

    uploadArea.addEventListener('dragenter', (e) => {
        console.log('dragenter on uploadArea');
        e.preventDefault();
        e.stopPropagation();
        uploadArea.classList.add('dragover');
    });

    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        uploadArea.classList.add('dragover');
    });

    uploadArea.addEventListener('dragleave', (e) => {
        console.log('dragleave on uploadArea');
        e.preventDefault();
        e.stopPropagation();
        uploadArea.classList.remove('dragover');
    });

    uploadArea.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        uploadArea.classList.remove('dragover');

        const dt = e.dataTransfer;
        const files = dt?.files;
        const htmlData = dt?.getData('text/html') || '';

        // Standard files API
        if (files && files.length > 0) {
            await uploadFiles(Array.from(files));
            return;
        }

        // WebKitGTK/Linux: extract file:// URLs from HTML
        if (htmlData.includes('file://')) {
            const matches = htmlData.match(/file:\/\/[^"'<>\s\]]+/g);
            if (matches && matches.length > 0) {
                const paths = [...new Set(matches)].map(uri => decodeURIComponent(uri.replace('file://', '')));
                await uploadFilesFromPaths(paths);
                return;
            }
        }

        console.log('No files in drop - use Browse for multiple files');
    });
};

// Context Menu Functions
let contextMenuTarget = null;

function showContextMenu(event, fileItem) {
    const contextMenu = document.getElementById('contextMenu');
    
    // Hide any existing context menu
    contextMenu.style.display = 'none';
    
    // Remove previous selection
    document.querySelectorAll('.file-item').forEach(item => {
        item.classList.remove('context-selected');
    });
    
    // Select the target item
    fileItem.classList.add('context-selected');
    contextMenuTarget = fileItem;
    
    // Get file type to show/hide relevant menu items
    const fileType = fileItem.getAttribute('data-filetype');
    const isDirectory = fileType === 'directory';
    
    // Show/hide menu items based on file type
    const editMenuItem = contextMenu.querySelector('[onclick*="edit"]');
    const downloadMenuItem = contextMenu.querySelector('[onclick*="download"]');
    
    if (editMenuItem) {
        editMenuItem.style.display = isDirectory ? 'none' : 'flex';
    }
    if (downloadMenuItem) {
        downloadMenuItem.style.display = isDirectory ? 'none' : 'flex';
    }
    
    // Position the context menu
    contextMenu.style.left = event.pageX + 'px';
    contextMenu.style.top = event.pageY + 'px';
    contextMenu.style.display = 'block';
    
    // Hide context menu when clicking elsewhere
    setTimeout(() => {
        document.addEventListener('click', hideContextMenu, { once: true });
    }, 0);
}

function hideContextMenu() {
    const contextMenu = document.getElementById('contextMenu');
    contextMenu.style.display = 'none';
    
    // Remove selection highlight
    document.querySelectorAll('.file-item').forEach(item => {
        item.classList.remove('context-selected');
    });
    
    contextMenuTarget = null;
}

async function contextMenuAction(action) {
    if (!contextMenuTarget) return;
    
    const fileName = contextMenuTarget.getAttribute('data-filename');
    const fileType = contextMenuTarget.getAttribute('data-filetype');
    const filePath = currentPath.endsWith('/') ? 
        currentPath + fileName : 
        currentPath + '/' + fileName;
    
    hideContextMenu();
    
    switch (action) {
        case 'download':
            await downloadFile(fileName);
            break;
        case 'edit':
            await editFile(fileName);
            break;
        case 'rename':
            showRenameModal(fileName);
            break;
        case 'delete':
            await deleteFileOrFolder(fileName, fileType, filePath);
            break;
    }
}

async function downloadFile(fileName) {
    const remotePath = currentPath.endsWith('/') ? 
        currentPath + fileName : 
        currentPath + '/' + fileName;
    
    try {
        console.log('Downloading:', remotePath);
        
        // Get file size info
        const infoResult = await window.pywebview.api.get_file_info(currentSessionId, remotePath);
        const infoResponse = JSON.parse(infoResult);
        
        let fileSize = 0;
        if (infoResponse.success && infoResponse.info && infoResponse.info.size) {
            fileSize = infoResponse.info.size;
            console.log(`File size: ${(fileSize / (1024 * 1024)).toFixed(2)}MB`);
        }
        
        // DEFAULT TO NATIVE FILE DIALOG - no stupid prompts
        // Always show the native OS file dialog first
        await downloadFileWithPicker(fileName, remotePath);
        
    } catch (error) {
        console.error('Download error:', error);
        alert('Download failed: ' + error.message);
    }
}

async function downloadFileToBrowser(fileName, remotePath) {
    try {
        // Get file size first
        const infoResult = await window.pywebview.api.get_file_info(currentSessionId, remotePath);
        const infoResponse = JSON.parse(infoResult);
        const fileSize = infoResponse.success ? infoResponse.info.size : 0;
        
        // For large files (>50MB), automatically use native file dialog instead of browser download
        if (fileSize > 50 * 1024 * 1024) {
            console.log(`File is ${(fileSize/(1024*1024)).toFixed(1)}MB - using native file dialog for better performance`);
            await downloadFileWithPicker(fileName, remotePath);
            return;
        }
        
        // Show download progress with file size and cancel button
        const progressNotification = showDownloadProgressWithCancel(fileName, fileSize);
        
        // Generate unique download ID
        const downloadId = 'dl_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        
        // Start download with progress tracking
        const startResult = await window.pywebview.api.start_download_with_progress(currentSessionId, remotePath, downloadId);
        const startResponse = JSON.parse(startResult);
        
        if (!startResponse.success) {
            // Hide progress notification on error
            if (progressNotification.parentNode) {
                progressNotification.parentNode.removeChild(progressNotification);
            }
            alert(`Failed to start download: ${startResponse.error}`);
            return;
        }
        
        // Poll for progress updates
        const progressInterval = setInterval(async () => {
            try {
                const progressResult = await window.pywebview.api.get_download_progress(currentSessionId, downloadId);
                const progress = JSON.parse(progressResult);
                
                if (progress.status === 'downloading' && progress.total > 0) {
                    updateDownloadProgress(progress.downloaded, progress.total);
                } else if (progress.status === 'completed') {
                    clearInterval(progressInterval);
                    
                    // Download completed - process the content asynchronously to avoid UI freeze
                    if (progress.content) {
                        console.log('Processing download completion...');
                        updateDownloadProgress(progress.size, progress.size);
                        
                        // Process large files asynchronously to prevent UI freeze
                        processDownloadCompletion(progress.content, fileName, progressNotification);
                    }
                } else if (progress.status === 'error') {
                    clearInterval(progressInterval);
                    
                    // Hide progress notification on error
                    if (progressNotification.parentNode) {
                        progressNotification.parentNode.removeChild(progressNotification);
                    }
                    
                    let errorMsg = progress.error || 'Unknown error';
                    if (errorMsg.includes('Garbage packet')) {
                        errorMsg = `Download failed due to connection issues.\n\nTry using "Choose Save Location" option instead for large files.`;
                    }
                    
                    alert(`Download failed: ${errorMsg}`);
                } else if (progress.status === 'cancelled') {
                    clearInterval(progressInterval);
                    
                    // Hide progress notification
                    if (progressNotification.parentNode) {
                        progressNotification.parentNode.removeChild(progressNotification);
                    }
                    
                    console.log('Download cancelled by user');
                }
            } catch (error) {
                console.error('Error polling download progress:', error);
                clearInterval(progressInterval);
                
                // Hide progress notification on error
                if (progressNotification.parentNode) {
                    progressNotification.parentNode.removeChild(progressNotification);
                }
                alert('Download failed: ' + error.message);
            }
        }, 1000); // Poll every 1000ms to reduce overhead
        
        // Store interval for cancellation
        progressNotification.downloadId = downloadId;
        progressNotification.progressInterval = progressInterval;
        
        return; // Early return since we're handling everything in the polling loop
        
    } catch (error) {
        console.error('Browser download error:', error);
        
        // Hide progress notification on error
        if (progressNotification && progressNotification.parentNode) {
            progressNotification.parentNode.removeChild(progressNotification);
        }
        
        alert('Browser download failed: ' + error.message);
    }
}

async function downloadFileWithPicker(fileName, remotePath) {
    try {
        // Show native save file dialog
        const dialogResult = await window.pywebview.api.show_save_file_dialog(fileName);
        const dialogResponse = JSON.parse(dialogResult);
        
        if (!dialogResponse.success) {
            if (dialogResponse.cancelled) {
                return; // User cancelled
            } else if (dialogResponse.fallback_needed) {
                // Fallback to simple prompt if native dialog fails
                const savePath = prompt(
                    `Native file dialog not available. Enter save path for "${fileName}":`,
                    `${fileName}`
                );
                
                if (!savePath) {
                    return; // User cancelled
                }
                
                // Use the prompted path
                dialogResponse.success = true;
                dialogResponse.path = savePath;
            } else {
                alert(`Error opening save dialog: ${dialogResponse.error || 'Unknown error'}`);
                return;
            }
        }
        
        const savePath = dialogResponse.path;
        
        // Get file size first
        const infoResult = await window.pywebview.api.get_file_info(currentSessionId, remotePath);
        const infoResponse = JSON.parse(infoResult);
        const fileSize = infoResponse.success ? infoResponse.info.size : 0;
        
        // Show download progress with cancel button
        const progressNotification = showDownloadProgressWithCancel(fileName, fileSize);
        
        console.log(`Starting REAL progress tracked download to: ${savePath}`);
        
        // Generate unique download ID for REAL progress tracking
        const downloadId = 'picker_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        
        // Start DIRECT download with REAL progress tracking - no content transfer through browser
        const startResult = await window.pywebview.api.start_direct_download_with_progress(currentSessionId, remotePath, savePath, downloadId);
        const startResponse = JSON.parse(startResult);
        
        if (!startResponse.success) {
            // Hide progress notification on error
            if (progressNotification.parentNode) {
                progressNotification.parentNode.removeChild(progressNotification);
            }
            alert(`Failed to start download: ${startResponse.error}`);
            return;
        }
        
        // Poll for REAL progress updates
        const progressInterval = setInterval(async () => {
            try {
                const progressResult = await window.pywebview.api.get_download_progress(currentSessionId, downloadId);
                const progress = JSON.parse(progressResult);
                
                if (progress.status === 'downloading' && progress.total > 0) {
                    // This is REAL progress from the actual download
                    updateDownloadProgress(progress.downloaded, progress.total);
                } else if (progress.status === 'completed') {
                    clearInterval(progressInterval);
                    
                    // Download completed directly to chosen path - no content transfer needed!
                    console.log('Direct download with REAL progress completed to:', savePath);
                    
                    // Show completion
                    updateDownloadProgress(progress.downloaded || fileSize, progress.total || fileSize);
                    
                    // Hide progress after showing 100%
                    setTimeout(() => {
                        if (progressNotification && progressNotification.parentNode) {
                            progressNotification.parentNode.removeChild(progressNotification);
                        }
                    }, 1500);
                    
                    showSuccessNotification(`Downloaded to ${savePath}`);
                } else if (progress.status === 'error') {
                    clearInterval(progressInterval);
                    
                    // Hide progress notification on error
                    if (progressNotification.parentNode) {
                        progressNotification.parentNode.removeChild(progressNotification);
                    }
                    
                    let errorMsg = progress.error || 'Unknown error';
                    if (errorMsg.includes('Garbage packet')) {
                        errorMsg = `Download failed due to connection issues.\n\nPlease try again.`;
                    }
                    
                    alert(`Download failed: ${errorMsg}`);
                } else if (progress.status === 'cancelled') {
                    clearInterval(progressInterval);
                    
                    // Hide progress notification
                    if (progressNotification.parentNode) {
                        progressNotification.parentNode.removeChild(progressNotification);
                    }
                    
                    console.log('Download cancelled by user');
                }
            } catch (error) {
                console.error('Error polling download progress:', error);
                clearInterval(progressInterval);
                
                // Hide progress notification on error
                if (progressNotification.parentNode) {
                    progressNotification.parentNode.removeChild(progressNotification);
                }
                alert('Download failed: ' + error.message);
            }
        }, 1000); // Poll every 1000ms for REAL progress
        
        // Store interval for cancellation (REAL cancellation that actually works)
        progressNotification.downloadId = downloadId;
        progressNotification.progressInterval = progressInterval;
        progressNotification.isDirectDownload = false; // This uses REAL progress tracking with REAL cancellation
        
    } catch (error) {
        console.error('Direct download error:', error);
        alert('Download failed: ' + error.message);
    }
}


function showDownloadProgress(fileName, fileSize = null) {
    const notification = document.createElement('div');
    notification.id = 'downloadProgress';
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: linear-gradient(135deg, #1a1a1a 0%, #2a2a2a 100%);
        border: 2px solid #00d4ff;
        border-radius: 12px;
        padding: 20px;
        min-width: 350px;
        max-width: 450px;
        z-index: 10001;
        box-shadow: 0 8px 32px rgba(0, 212, 255, 0.3);
        backdrop-filter: blur(10px);
        color: white;
        font-family: 'Inter', sans-serif;
    `;
    
    const sizeInfo = fileSize ? ` (${(fileSize / (1024 * 1024)).toFixed(2)}MB)` : '';
    const truncatedName = fileName.length > 25 ? fileName.substring(0, 22) + '...' : fileName;
    
    notification.innerHTML = `
        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
            <div style="
                width: 20px;
                height: 20px;
                border: 3px solid rgba(0, 212, 255, 0.3);
                border-top-color: #00d4ff;
                border-radius: 50%;
                animation: spin 1s linear infinite;
            " id="spinner"></div>
            <div>
                <div style="font-weight: 600; font-size: 14px; color: #00d4ff;">Downloading</div>
                <div style="font-size: 12px; color: #e0e0e0;" title="${escapeHtml(fileName)}">${escapeHtml(truncatedName)}${sizeInfo}</div>
            </div>
        </div>
        
        <div style="margin-bottom: 8px;">
            <div style="
                width: 100%;
                height: 8px;
                background: rgba(255, 255, 255, 0.1);
                border-radius: 4px;
                overflow: hidden;
                position: relative;
            ">
                <div id="progressBar" style="
                    width: 0%;
                    height: 100%;
                    background: linear-gradient(90deg, #00d4ff, #0099cc);
                    border-radius: 4px;
                    transition: width 0.3s ease;
                    position: relative;
                ">
                    <div style="
                        position: absolute;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        background: linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent);
                        animation: shimmer 2s infinite;
                    "></div>
                </div>
            </div>
        </div>
        
        <div style="display: flex; justify-content: space-between; font-size: 11px; color: #a0a0a0;">
            <span id="progressText">Initializing...</span>
            <span id="progressPercent">0%</span>
        </div>
    `;
    
    document.body.appendChild(notification);
    return notification;
}

function showDownloadProgressWithCancel(fileName, fileSize = null) {
    const notification = document.createElement('div');
    notification.id = 'downloadProgress';
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: linear-gradient(135deg, #1a1a1a 0%, #2a2a2a 100%);
        border: 2px solid #00d4ff;
        border-radius: 12px;
        padding: 20px;
        min-width: 350px;
        max-width: 450px;
        z-index: 10001;
        box-shadow: 0 8px 32px rgba(0, 212, 255, 0.3);
        backdrop-filter: blur(10px);
        color: white;
        font-family: 'Inter', sans-serif;
    `;
    
    const sizeInfo = fileSize ? ` (${(fileSize / (1024 * 1024)).toFixed(2)}MB)` : '';
    const truncatedName = fileName.length > 25 ? fileName.substring(0, 22) + '...' : fileName;
    
    notification.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
            <div style="display: flex; align-items: center; gap: 12px;">
                <div style="
                    width: 20px;
                    height: 20px;
                    border: 3px solid rgba(0, 212, 255, 0.3);
                    border-top-color: #00d4ff;
                    border-radius: 50%;
                    animation: spin 1s linear infinite;
                " id="spinner"></div>
                <div>
                    <div style="font-weight: 600; font-size: 14px; color: #00d4ff;">Downloading</div>
                    <div style="font-size: 12px; color: #e0e0e0;" title="${escapeHtml(fileName)}">${escapeHtml(truncatedName)}${sizeInfo}</div>
                </div>
            </div>
            <button id="cancelDownload" style="
                background: rgba(255, 68, 68, 0.2);
                border: 1px solid rgba(255, 68, 68, 0.5);
                border-radius: 4px;
                color: #ff6b6b;
                padding: 4px 8px;
                font-size: 11px;
                cursor: pointer;
                transition: all 0.2s ease;
            " onmouseover="this.style.background='rgba(255, 68, 68, 0.3)'" onmouseout="this.style.background='rgba(255, 68, 68, 0.2)'">Cancel</button>
        </div>
        
        <div style="margin-bottom: 8px;">
            <div style="
                width: 100%;
                height: 8px;
                background: rgba(255, 255, 255, 0.1);
                border-radius: 4px;
                overflow: hidden;
                position: relative;
            ">
                <div id="progressBar" style="
                    width: 0%;
                    height: 100%;
                    background: linear-gradient(90deg, #00d4ff, #0099cc);
                    border-radius: 4px;
                    transition: width 0.3s ease;
                    position: relative;
                ">
                    <div style="
                        position: absolute;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        background: linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent);
                        animation: shimmer 2s infinite;
                    "></div>
                </div>
            </div>
        </div>
        
        <div style="display: flex; justify-content: space-between; font-size: 11px; color: #a0a0a0;">
            <span id="progressText">Initializing...</span>
            <span id="progressPercent">0%</span>
        </div>
    `;
    
    document.body.appendChild(notification);
    
    // Add cancel functionality
    const cancelButton = notification.querySelector('#cancelDownload');
    cancelButton.addEventListener('click', async () => {
        if (notification.downloadId && notification.progressInterval) {
            try {
                // Check if this is a direct download or threaded download
                if (notification.isDirectDownload) {
                    // For direct downloads, we can only stop the progress simulation
                    console.log('Stopping direct download progress (note: actual download cannot be cancelled)');
                    clearInterval(notification.progressInterval);
                    
                    // Remove the notification
                    if (notification.parentNode) {
                        notification.parentNode.removeChild(notification);
                    }
                } else {
                    // For threaded downloads, cancel properly
                    await window.pywebview.api.cancel_download(currentSessionId, notification.downloadId);
                    
                    // Clear the progress polling
                    clearInterval(notification.progressInterval);
                    
                    // Remove the notification
                    if (notification.parentNode) {
                        notification.parentNode.removeChild(notification);
                    }
                }
                
                console.log('Download cancelled by user');
            } catch (error) {
                console.error('Error cancelling download:', error);
            }
        }
    });
    
    return notification;
}

async function processDownloadCompletion(base64Content, fileName, progressNotification) {
    try {
        console.log('Starting async file processing...');
        
        // Show processing status
        const progressText = document.getElementById('progressText');
        const spinner = document.getElementById('spinner');
        if (progressText) {
            progressText.textContent = 'Processing file...';
        }
        if (spinner) {
            spinner.style.display = 'block';
        }
        
        // Process large base64 content in chunks to avoid UI freeze
        const chunkSize = 1024 * 1024; // 1MB chunks
        const contentLength = base64Content.length;
        const chunks = [];
        
        // Decode base64 in chunks using requestAnimationFrame to keep UI responsive
        for (let i = 0; i < contentLength; i += chunkSize) {
            const chunk = base64Content.slice(i, i + chunkSize);
            chunks.push(chunk);
            
            // Yield to browser every chunk to keep UI responsive
            if (i % (chunkSize * 4) === 0) { // Every 4MB
                await new Promise(resolve => requestAnimationFrame(resolve));
            }
        }
        
        console.log(`Split into ${chunks.length} chunks, decoding...`);
        
        // Decode chunks
        const binaryChunks = [];
        for (let i = 0; i < chunks.length; i++) {
            try {
                const binaryString = atob(chunks[i]);
                const bytes = new Uint8Array(binaryString.length);
                for (let j = 0; j < binaryString.length; j++) {
                    bytes[j] = binaryString.charCodeAt(j);
                }
                binaryChunks.push(bytes);
                
                // Update processing progress
                if (progressText) {
                    const processPercent = Math.round(((i + 1) / chunks.length) * 100);
                    progressText.textContent = `Processing file... ${processPercent}%`;
                }
                
                // Yield to browser every few chunks
                if (i % 5 === 0) {
                    await new Promise(resolve => requestAnimationFrame(resolve));
                }
            } catch (e) {
                console.error('Error decoding chunk', i, ':', e);
                throw new Error(`Failed to decode file chunk ${i}: ${e.message}`);
            }
        }
        
        console.log('Creating blob...');
        
        // Create blob from chunks
        const blob = new Blob(binaryChunks, { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        
        console.log('Triggering download...');
        
        // Create download link
        const downloadLink = document.createElement('a');
        downloadLink.href = url;
        downloadLink.download = fileName;
        downloadLink.style.display = 'none';
        
        // Trigger download
        document.body.appendChild(downloadLink);
        downloadLink.click();
        document.body.removeChild(downloadLink);
        
        // Hide progress after showing completion
        setTimeout(() => {
            if (progressNotification && progressNotification.parentNode) {
                progressNotification.parentNode.removeChild(progressNotification);
            }
        }, 1000);
        
        // Clean up
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        
        console.log('Successfully downloaded to browser:', fileName);
        showSuccessNotification(`Downloaded ${fileName}`);
        
    } catch (error) {
        console.error('Error processing download:', error);
        
        // Hide progress on error
        if (progressNotification && progressNotification.parentNode) {
            progressNotification.parentNode.removeChild(progressNotification);
        }
        
        alert(`Failed to process download: ${error.message}`);
    }
}

function updateDownloadProgress(downloaded, total, speed = null) {
    const progressBar = document.getElementById('progressBar');
    const progressText = document.getElementById('progressText');
    const progressPercent = document.getElementById('progressPercent');
    const spinner = document.getElementById('spinner');
    
    if (!progressBar) return;
    
    const percentage = total > 0 ? Math.round((downloaded / total) * 100) : 0;
    const downloadedMB = (downloaded / (1024 * 1024)).toFixed(1);
    const totalMB = (total / (1024 * 1024)).toFixed(1);
    
    // Update progress bar
    progressBar.style.width = `${percentage}%`;
    
    // Update text
    let statusText = `${downloadedMB}MB / ${totalMB}MB`;
    if (speed) {
        const speedMB = (speed / (1024 * 1024)).toFixed(1);
        statusText += ` • ${speedMB}MB/s`;
    }
    
    progressText.textContent = statusText;
    progressPercent.textContent = `${percentage}%`;
    
    // Hide spinner when we have real progress
    if (percentage > 0 && spinner) {
        spinner.style.display = 'none';
    }
}

function showSuccessNotification(message) {
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: rgba(0, 255, 136, 0.9);
        color: white;
        padding: 12px 20px;
        border-radius: 6px;
        font-size: 14px;
        z-index: 10001;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        backdrop-filter: blur(10px);
    `;
    notification.textContent = `✓ ${message}`;
    
    document.body.appendChild(notification);
    
    // Remove after 3 seconds
    setTimeout(() => {
        if (notification.parentNode) {
            notification.parentNode.removeChild(notification);
        }
    }, 3000);
}

async function editFile(fileName) {
    const remotePath = currentPath.endsWith('/') ? 
        currentPath + fileName : 
        currentPath + '/' + fileName;
    
    try {
        console.log('Opening file for editing:', remotePath);
        
        // Request file to be prepared for editing
        const result = await window.pywebview.api.edit_file(currentSessionId, remotePath);
        const response = JSON.parse(result);
        
        if (!response.success) {
            alert(`Failed to open file for editing: ${response.error}`);
            return;
        }
        
        const tempPath = response.temp_path;
        const displayName = response.file_name || fileName;
        
        // Show user that file is being opened
        // Python backend handles file watching and auto-sync
        console.log('File opened for editing at:', tempPath);
        
    } catch (error) {
        console.error('Edit error:', error);
        alert('Failed to open file for editing: ' + error.message);
    }
}

// Called from Python backend when a file is synced
function showSyncNotification(fileName) {
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: rgba(0, 212, 255, 0.9);
        color: white;
        padding: 12px 20px;
        border-radius: 6px;
        font-size: 14px;
        z-index: 10001;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        backdrop-filter: blur(10px);
    `;
    notification.textContent = `✓ ${fileName} synced`;

    document.body.appendChild(notification);

    setTimeout(() => {
        if (notification.parentNode) {
            notification.parentNode.removeChild(notification);
        }
    }, 3000);
}

async function deleteFileOrFolder(fileName, fileType, filePath) {
    const itemType = fileType === 'directory' ? 'folder' : 'file';
    
    if (!confirm(`Are you sure you want to delete this ${itemType}?\n\n${fileName}`)) {
        return;
    }
    
    try {
        let result;
        if (fileType === 'directory') {
            result = await window.pywebview.api.delete_directory(currentSessionId, filePath);
        } else {
            result = await window.pywebview.api.delete_file(currentSessionId, filePath);
        }
        
        const response = JSON.parse(result);
        if (response.success) {
            console.log('Successfully deleted:', fileName);
            // Refresh file list
            await listFiles(currentPath);
        } else {
            alert(`Failed to delete ${fileName}: ${response.error}`);
        }
    } catch (error) {
        console.error('Delete error:', error);
        alert('Delete failed: ' + error.message);
    }
}

// Rename Modal Functions
let renameTarget = null;

function showRenameModal(fileName) {
    renameTarget = fileName;
    const modal = document.getElementById('renameModal');
    const input = document.getElementById('renameInput');
    
    input.value = fileName;
    modal.style.display = 'flex';
    
    // Focus and select the filename (without extension for files)
    setTimeout(() => {
        input.focus();
        if (fileName.includes('.')) {
            const dotIndex = fileName.lastIndexOf('.');
            input.setSelectionRange(0, dotIndex);
        } else {
            input.select();
        }
    }, 100);
    
    // Handle Enter key
    input.onkeyup = (e) => {
        if (e.key === 'Enter') {
            confirmRename();
        } else if (e.key === 'Escape') {
            closeRenameModal();
        }
    };
}

function closeRenameModal() {
    const modal = document.getElementById('renameModal');
    modal.style.display = 'none';
    renameTarget = null;
}

async function confirmRename() {
    const newName = document.getElementById('renameInput').value.trim();
    
    if (!newName) {
        alert('Please enter a valid name');
        return;
    }
    
    if (newName === renameTarget) {
        closeRenameModal();
        return;
    }
    
    const oldPath = currentPath.endsWith('/') ? 
        currentPath + renameTarget : 
        currentPath + '/' + renameTarget;
    
    const newPath = currentPath.endsWith('/') ? 
        currentPath + newName : 
        currentPath + '/' + newName;
    
    try {
        const result = await window.pywebview.api.rename_file(currentSessionId, oldPath, newPath);
        const response = JSON.parse(result);
        
        if (response.success) {
            console.log('Successfully renamed:', renameTarget, 'to', newName);
            closeRenameModal();
            // Refresh file list
            await listFiles(currentPath);
        } else {
            alert(`Failed to rename: ${response.error}`);
        }
    } catch (error) {
        console.error('Rename error:', error);
        alert('Rename failed: ' + error.message);
    }
}

// HTML escaping function to prevent XSS
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
}

// JavaScript string escaping for use in onclick attributes
function escapeJs(str) {
    if (!str) return '';
    return str.replace(/\\/g, '\\\\')
              .replace(/'/g, "\\'")
              .replace(/"/g, '\\"')
              .replace(/\n/g, '\\n')
              .replace(/\r/g, '\\r');
}

// Toggle collapsible sections
function toggleSection(sectionName) {
    const content = document.getElementById(sectionName + 'Content');
    const chevron = document.getElementById(sectionName + 'Chevron');
    
    content.classList.toggle('open');
    chevron.classList.toggle('open');
}

// Load saved connections on startup
async function loadSavedConnections() {
    try {
        console.log('Loading saved connections...');
        const [response, groupsResponse] = await Promise.all([
            window.pywebview.api.get_saved_connections(),
            window.pywebview.api.get_connection_groups()
        ]);
        const connections = JSON.parse(response);
        savedConnectionGroups = JSON.parse(groupsResponse);
        console.log('Loaded connections:', connections.length, 'items');
        updateSavedConnectionsList(connections);
    } catch (error) {
        console.error('Error loading saved connections:', error);
    }
}

function updateSavedConnectionsList(connections) {
    const container = document.getElementById('savedConnectionsList');
    container.innerHTML = '';
    
    if (connections.length === 0) {
        container.innerHTML = '<div class="empty-message">No saved connections</div>';
        return;
    }
    
    const tree = buildBookmarkTree(connections);
    tree.children.forEach((childNode, index) => {
        if (childNode.type === 'group') {
            container.appendChild(renderGroupNode(childNode, 0, index));
        }
    });

    if (tree.connections.length > 0) {
        const ungroupedNode = {
            type: 'group',
            name: 'Ungrouped',
            fullPath: '',
            children: [],
            connections: tree.connections
        };
        container.appendChild(renderGroupNode(ungroupedNode, 0, 'ungrouped'));
    }
}

function buildBookmarkTree(connections) {
    const root = {
        type: 'root',
        name: 'root',
        fullPath: '',
        children: [],
        connections: []
    };

    const allGroups = new Set(savedConnectionGroups || []);
    connections.forEach(conn => {
        if (conn.group) allGroups.add(conn.group);
    });

    Array.from(allGroups)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b))
        .forEach(groupPath => {
            const parts = groupPath.split('/').map(p => p.trim()).filter(Boolean);
            let currentNode = root;
            let currentPath = '';

            parts.forEach(part => {
                currentPath = currentPath ? `${currentPath}/${part}` : part;
                let next = currentNode.children.find(child => child.name === part);
                if (!next) {
                    next = {
                        type: 'group',
                        name: part,
                        fullPath: currentPath,
                        children: [],
                        connections: []
                    };
                    currentNode.children.push(next);
                }
                currentNode = next;
            });
        });

    connections.forEach(conn => {
        const groupPath = (conn.group || '').trim();
        if (!groupPath) {
            root.connections.push(conn);
            return;
        }

        const parts = groupPath.split('/').map(p => p.trim()).filter(Boolean);
        let currentNode = root;

        for (const part of parts) {
            let next = currentNode.children.find(child => child.name === part);
            if (!next) {
                const fallbackPath = currentNode.fullPath ? `${currentNode.fullPath}/${part}` : part;
                next = {
                    type: 'group',
                    name: part,
                    fullPath: fallbackPath,
                    children: [],
                    connections: []
                };
                currentNode.children.push(next);
            }
            currentNode = next;
        }

        currentNode.connections.push(conn);
    });

    sortBookmarkTree(root);
    return root;
}

function sortBookmarkTree(node) {
    if (node.children) {
        node.children.sort((a, b) => a.name.localeCompare(b.name));
        node.children.forEach(sortBookmarkTree);
    }
    if (node.connections) {
        node.connections.sort((a, b) => (a.name || a.key || '').localeCompare(b.name || b.key || ''));
    }
}

function isBookmarkExpanded(path) {
    if (!path) return true;
    return expandedBookmarkNodes.has(path);
}

function toggleBookmarkGroup(path) {
    if (!path) return;
    if (expandedBookmarkNodes.has(path)) {
        expandedBookmarkNodes.delete(path);
    } else {
        expandedBookmarkNodes.add(path);
    }
    loadSavedConnections();
}

function renderGroupNode(node, depth, nodeIndex) {
    const isExpanded = isBookmarkExpanded(node.fullPath);
    const wrapper = document.createElement('div');
    wrapper.className = 'bookmark-group-node';

    const hasChildren = (node.children && node.children.length > 0) || (node.connections && node.connections.length > 0);
    const count = (node.connections ? node.connections.length : 0) + countNestedConnections(node.children || []);
    const indent = depth * 14;

    const groupActions = node.fullPath
        ? `
            <button class="group-action-btn" onclick="createConnectionSubgroup('${escapeJs(node.fullPath)}'); event.stopPropagation();">+ Sub</button>
            <button class="group-action-btn" onclick="renameConnectionGroup('${escapeJs(node.fullPath)}'); event.stopPropagation();">Rename</button>
            <button class="group-action-btn delete" onclick="deleteConnectionGroup('${escapeJs(node.fullPath)}'); event.stopPropagation();">Delete</button>
        `
        : '';

    wrapper.innerHTML = `
        <div class="connection-group-header bookmark-group-header" style="padding-left: ${2 + indent}px;" onclick="${node.fullPath ? `toggleBookmarkGroup('${escapeJs(node.fullPath)}')` : ''}">
            <span class="bookmark-caret ${isExpanded ? 'open' : ''}">${hasChildren ? '▾' : '•'}</span>
            <span class="connection-group-title">${escapeHtml(node.name)}</span>
            <span class="connection-group-count">${count}</span>
            <div class="connection-group-actions">${groupActions}</div>
        </div>
    `;

    if (isExpanded) {
        node.children.forEach((childNode, index) => {
            wrapper.appendChild(renderGroupNode(childNode, depth + 1, `${nodeIndex}-${index}`));
        });

        node.connections.forEach(conn => {
            wrapper.appendChild(createSavedConnectionItem(conn, depth + 1));
        });
    }

    return wrapper;
}

function countNestedConnections(children) {
    return children.reduce((total, child) => {
        const direct = child.connections ? child.connections.length : 0;
        return total + direct + countNestedConnections(child.children || []);
    }, 0);
}

function createSavedConnectionItem(conn, depth = 0) {
    const displayName = getBookmarkDisplayName(conn);
    const portVal = conn.port != null ? String(conn.port) : '22';
    const detailLine = `${conn.username}@${conn.hostname}:${portVal}`;
    const menuId = `bmdd-${bookmarkDropdownSeq++}`;
    const key = conn.key;
    const renameLabel = displayName;

    const item = document.createElement('div');
    item.className = 'saved-connection-item bookmark-item';
    item.style.marginLeft = `${depth * 14}px`;

    item.innerHTML = `
        <div class="saved-connection-main">
            <div class="saved-connection-text"></div>
            <div class="bookmark-gear-wrap">
                <button type="button" class="bookmark-gear-btn"
                    aria-haspopup="true" aria-expanded="false"
                    aria-label="Opções da conexão" title="Opções">⚙</button>
                <div class="bookmark-dropdown" id="${menuId}" role="menu" aria-hidden="true"></div>
            </div>
        </div>`;

    const textEl = item.querySelector('.saved-connection-text');
    textEl.title = `${detailLine} • Duplo clique para conectar`;

    const nameEl = document.createElement('div');
    nameEl.className = 'saved-connection-name';
    nameEl.textContent = displayName;

    const detailEl = document.createElement('div');
    detailEl.className = 'saved-connection-details';
    detailEl.textContent = detailLine;

    textEl.appendChild(nameEl);
    textEl.appendChild(detailEl);

    textEl.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void quickConnect(key);
    });

    const gearBtn = item.querySelector('.bookmark-gear-btn');
    const dropdown = item.querySelector('.bookmark-dropdown');
    if (!gearBtn || !dropdown) {
        console.error('Bookmark item: missing gear or dropdown');
        return item;
    }
    gearBtn.addEventListener('click', (e) => toggleBookmarkDropdown(e, menuId));

    function addMenuItem(label, danger, handler) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = danger ? 'bookmark-menu-item bookmark-menu-danger' : 'bookmark-menu-item';
        btn.role = 'menuitem';
        btn.textContent = label;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeBookmarkOptionMenus();
            handler();
        });
        dropdown.appendChild(btn);
    }

    addMenuItem('Editar', false, () => void editSavedBookmark(key));
    addMenuItem('Conectar', false, () => void quickConnect(key));
    addMenuItem('Renomear', false, () => renameConnection(key, renameLabel));
    addMenuItem('Grupo…', false, () => moveConnectionToGroup(key, conn.group || ''));
    addMenuItem('Excluir', true, () => deleteConnection(key));

    return item;
}

async function loadConnection(key) {
    const connections = JSON.parse(await window.pywebview.api.get_saved_connections());
    const conn = connections.find(c => c.key === key);
    if (conn) {
        document.getElementById('hostname').value = conn.hostname;
        document.getElementById('port').value = conn.port || 22;
        document.getElementById('username').value = conn.username;
        document.getElementById('deviceName').value = conn.name || '';
        document.getElementById('connectionGroup').value = conn.group || '';
        
        if (conn.password) {
            document.getElementById('authType').value = 'password';
            document.getElementById('password').value = conn.password;
            document.getElementById('passwordGroup').style.display = 'block';
            document.getElementById('keyGroup').style.display = 'none';
        } else if (conn.keyPath) {
            document.getElementById('authType').value = 'key';
            document.getElementById('keyPath').value = conn.keyPath;
            document.getElementById('passwordGroup').style.display = 'none';
            document.getElementById('keyGroup').style.display = 'block';
        }
    }
}

async function quickConnect(key) {
    await loadConnection(key);
    await connect();
}

async function deleteConnection(key) {
    if (confirm('Are you sure you want to delete this saved connection?')) {
        console.log('Deleting connection:', key);
        try {
            const result = await window.pywebview.api.delete_saved_connection(key);
            const parsedResult = JSON.parse(result);
            console.log('Delete result:', parsedResult);
            
            if (parsedResult.success) {
                // Add a small delay to ensure file system has updated
                await new Promise(resolve => setTimeout(resolve, 100));
                await loadSavedConnections();
            } else {
                alert('Failed to delete connection: ' + (parsedResult.error || 'Unknown error'));
            }
        } catch (error) {
            console.error('Error deleting connection:', error);
            alert('Error deleting connection');
        }
    }
}

async function renameConnection(key, currentName) {
    const newName = prompt('New host name:', currentName || '');
    if (newName === null) return;

    const trimmedName = newName.trim();
    if (!trimmedName) {
        alert('Host name cannot be empty');
        return;
    }

    try {
        const result = await window.pywebview.api.rename_saved_connection(key, trimmedName);
        const parsedResult = JSON.parse(result);
        if (parsedResult.success) {
            await loadSavedConnections();
        } else {
            alert('Failed to rename host: ' + (parsedResult.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Error renaming connection:', error);
        alert('Error renaming host');
    }
}

async function moveConnectionToGroup(key, currentGroup) {
    const options = savedConnectionGroups.length > 0
        ? `Existing groups: ${savedConnectionGroups.join(', ')}\n\n`
        : '';
    const groupName = prompt(`${options}Enter group name, or leave empty for Ungrouped:`, currentGroup || '');
    if (groupName === null) return;

    try {
        const result = await window.pywebview.api.update_saved_connection_group(key, groupName.trim());
        const parsedResult = JSON.parse(result);
        if (parsedResult.success) {
            await loadSavedConnections();
        } else {
            alert('Failed to update host group: ' + (parsedResult.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Error moving connection to group:', error);
        alert('Error updating host group');
    }
}

async function createConnectionGroup() {
    const groupName = prompt('New group path (ex: DER_MG/Servidor_UOP):');
    if (groupName === null) return;

    const trimmedName = groupName.trim();
    if (!trimmedName) {
        alert('Group name cannot be empty');
        return;
    }

    try {
        const result = await window.pywebview.api.create_connection_group(trimmedName);
        const parsedResult = JSON.parse(result);
        if (parsedResult.success) {
            await loadSavedConnections();
        } else {
            alert('Failed to create group: ' + (parsedResult.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Error creating group:', error);
        alert('Error creating group');
    }
}

async function createConnectionSubgroup(parentPath) {
    const subgroup = prompt(`New subgroup under "${parentPath}"`);
    if (subgroup === null) return;
    const trimmedSubgroup = subgroup.trim();
    if (!trimmedSubgroup) {
        alert('Subgroup name cannot be empty');
        return;
    }

    const fullPath = `${parentPath}/${trimmedSubgroup}`;
    try {
        const result = await window.pywebview.api.create_connection_group(fullPath);
        const parsedResult = JSON.parse(result);
        if (parsedResult.success) {
            expandedBookmarkNodes.add(parentPath);
            await loadSavedConnections();
        } else {
            alert('Failed to create subgroup: ' + (parsedResult.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Error creating subgroup:', error);
        alert('Error creating subgroup');
    }
}

async function renameConnectionGroup(oldName) {
    const newName = prompt('New group path/name:', oldName);
    if (newName === null) return;

    const trimmedName = newName.trim();
    if (!trimmedName) {
        alert('Group name cannot be empty');
        return;
    }

    try {
        const result = await window.pywebview.api.rename_connection_group(oldName, trimmedName);
        const parsedResult = JSON.parse(result);
        if (parsedResult.success) {
            await loadSavedConnections();
        } else {
            alert('Failed to rename group: ' + (parsedResult.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Error renaming group:', error);
        alert('Error renaming group');
    }
}

async function deleteConnectionGroup(groupName) {
    if (!confirm(`Delete group "${groupName}" and all subgroups? Hosts will move to Ungrouped.`)) return;

    try {
        const result = await window.pywebview.api.delete_connection_group(groupName);
        const parsedResult = JSON.parse(result);
        if (parsedResult.success) {
            await loadSavedConnections();
        } else {
            alert('Failed to delete group: ' + (parsedResult.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Error deleting group:', error);
        alert('Error deleting group');
    }
}

// Check encryption status and show warning if needed
async function checkEncryptionStatus() {
    try {
        const response = await window.pywebview.api.get_encryption_status();
        const status = JSON.parse(response);
        
        if (status.warning_needed) {
            showEncryptionWarning();
        }
        
        // Add warning indicator to save connection checkbox if encryption not available
        if (!status.available) {
            addEncryptionWarningToUI();
        }
    } catch (error) {
        console.error('Error checking encryption status:', error);
        // If we can't check, assume no encryption and show warning
        showEncryptionWarning();
        addEncryptionWarningToUI();
    }
}

function addEncryptionWarningToUI() {
    const saveConnectionGroup = document.querySelector('.checkbox-group');
    if (saveConnectionGroup) {
        const warningBadge = document.createElement('span');
        warningBadge.innerHTML = ' ⚠️';
        warningBadge.style.color = '#ff6b35';
        warningBadge.style.fontSize = '12px';
        warningBadge.title = 'Warning: Passwords will be stored in plain text (cryptography package not installed)';
        
        const label = saveConnectionGroup.querySelector('label');
        if (label) {
            label.appendChild(warningBadge);
        }
    }
}

function showEncryptionWarning() {
    const warningHTML = `
        <div style="
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.8);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
            font-family: 'Inter', sans-serif;
        " id="encryptionWarningOverlay">
            <div style="
                background: linear-gradient(135deg, #1a1a1a 0%, #2a2a2a 100%);
                border: 2px solid #ff6b35;
                border-radius: 12px;
                padding: 30px;
                max-width: 500px;
                width: 90%;
                box-shadow: 0 20px 50px rgba(255, 107, 53, 0.3);
                text-align: center;
                color: #fff;
            ">
                <div style="
                    font-size: 48px;
                    margin-bottom: 20px;
                    color: #ff6b35;
                ">⚠️</div>
                
                <h2 style="
                    color: #ff6b35;
                    margin: 0 0 20px 0;
                    font-size: 24px;
                    font-weight: 700;
                ">Security Warning</h2>
                
                <p style="
                    margin: 0 0 20px 0;
                    font-size: 16px;
                    line-height: 1.5;
                    color: #e0e0e0;
                ">
                    <strong>Cryptography package not installed!</strong><br><br>
                    Your saved passwords will be stored in <strong>plain text</strong> format, 
                    which is not secure. Anyone with access to your computer can read them.
                </p>
                
                <div style="
                    background: rgba(255, 107, 53, 0.1);
                    border: 1px solid rgba(255, 107, 53, 0.3);
                    border-radius: 8px;
                    padding: 15px;
                    margin: 20px 0;
                    font-family: 'Consolas', monospace;
                    font-size: 14px;
                    color: #00d4ff;
                ">
                    pip install cryptography
                </div>
                
                <p style="
                    margin: 20px 0;
                    font-size: 14px;
                    color: #a0a0a0;
                ">
                    Install the cryptography package and restart PrismSSH to enable 
                    secure password encryption.
                </p>
                
                <div style="display: flex; gap: 10px; justify-content: center; margin-top: 25px;">
                    <button onclick="acknowledgeEncryptionWarning()" style="
                        background: linear-gradient(135deg, #ff6b35 0%, #e55a2b 100%);
                        border: none;
                        border-radius: 6px;
                        padding: 12px 24px;
                        color: white;
                        font-size: 14px;
                        font-weight: 600;
                        cursor: pointer;
                        transition: all 0.3s ease;
                    " onmouseover="this.style.transform='translateY(-1px)'; this.style.boxShadow='0 5px 15px rgba(255, 107, 53, 0.4)'"
                       onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='none'">
                        I Understand, Continue Anyway
                    </button>
                    
                    <button onclick="copyInstallCommand()" style="
                        background: rgba(255, 255, 255, 0.1);
                        border: 1px solid rgba(255, 255, 255, 0.2);
                        border-radius: 6px;
                        padding: 12px 24px;
                        color: white;
                        font-size: 14px;
                        font-weight: 600;
                        cursor: pointer;
                        transition: all 0.3s ease;
                    " onmouseover="this.style.background='rgba(255, 255, 255, 0.2)'"
                       onmouseout="this.style.background='rgba(255, 255, 255, 0.1)'">
                        Copy Install Command
                    </button>
                </div>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', warningHTML);
}

async function acknowledgeEncryptionWarning() {
    try {
        await window.pywebview.api.mark_encryption_warning_shown();
    } catch (error) {
        console.error('Error marking encryption warning as shown:', error);
    }
    
    const overlay = document.getElementById('encryptionWarningOverlay');
    if (overlay) {
        overlay.remove();
    }
}

function copyInstallCommand() {
    const command = 'pip install cryptography';
    
    if (navigator.clipboard) {
        navigator.clipboard.writeText(command).then(() => {
            // Show temporary feedback
            const button = event.target;
            const originalText = button.textContent;
            button.textContent = 'Copied!';
            button.style.background = 'rgba(0, 255, 136, 0.2)';
            
            setTimeout(() => {
                button.textContent = originalText;
                button.style.background = 'rgba(255, 255, 255, 0.1)';
            }, 2000);
        }).catch(err => {
            console.error('Failed to copy command:', err);
            alert('Install command: ' + command);
        });
    } else {
        // Fallback for older browsers
        alert('Install command: ' + command);
    }
}

async function connectWithHostVerification(sessionId, connectionParams) {
    try {
        console.log('Connecting session:', sessionId);
        
        // For now, connect directly without host key verification UI
        // TODO: Re-enable host key verification once API methods are confirmed
        const result = await window.pywebview.api.connect(
            sessionId, 
            JSON.stringify(connectionParams)
        );
        
        console.log('Connection result:', result);
        return JSON.parse(result);
        
    } catch (error) {
        console.error('Connection error:', error);
        return { success: false, error: error.toString() };
    }
}

function showHostKeyVerificationModal(details) {
    return new Promise((resolve) => {
        const modalHTML = `
            <div style="
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.8);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 10000;
                font-family: 'Inter', sans-serif;
            " id="hostKeyModal">
                <div style="
                    background: linear-gradient(135deg, #1a1a1a 0%, #2a2a2a 100%);
                    border: 2px solid #00d4ff;
                    border-radius: 12px;
                    padding: 30px;
                    max-width: 600px;
                    width: 90%;
                    box-shadow: 0 20px 50px rgba(0, 212, 255, 0.3);
                    color: #fff;
                ">
                    <div style="
                        font-size: 48px;
                        margin-bottom: 20px;
                        color: #00d4ff;
                        text-align: center;
                    ">🔐</div>
                    
                    <h2 style="
                        color: #00d4ff;
                        margin: 0 0 20px 0;
                        font-size: 24px;
                        font-weight: 700;
                        text-align: center;
                    ">Unknown Host Key</h2>
                    
                    <p style="
                        margin: 0 0 20px 0;
                        font-size: 16px;
                        line-height: 1.5;
                        color: #e0e0e0;
                    ">
                        The authenticity of host <strong>${escapeHtml(details.hostname)}</strong> can't be established.
                    </p>
                    
                    <div style="
                        background: rgba(0, 212, 255, 0.1);
                        border: 1px solid rgba(0, 212, 255, 0.3);
                        border-radius: 8px;
                        padding: 15px;
                        margin: 20px 0;
                        font-family: 'Consolas', monospace;
                        font-size: 14px;
                    ">
                        <strong>Key Type:</strong> ${escapeHtml(details.key_type)}<br>
                        <strong>Fingerprint:</strong><br>
                        <span style="color: #00ff88; word-break: break-all;">${escapeHtml(details.fingerprint)}</span>
                    </div>
                    
                    <p style="
                        margin: 20px 0;
                        font-size: 14px;
                        color: #ffa500;
                    ">
                        ⚠️ <strong>Are you sure you want to continue connecting?</strong><br>
                        If you trust this host, the key will be saved for future connections.
                    </p>
                    
                    <div style="display: flex; gap: 10px; justify-content: center; margin-top: 25px;">
                        <button onclick="document.getElementById('hostKeyModal').remove(); window.hostKeyResolve(true)" style="
                            background: linear-gradient(135deg, #00d4ff 0%, #0099cc 100%);
                            border: none;
                            border-radius: 6px;
                            padding: 12px 24px;
                            color: white;
                            font-size: 14px;
                            font-weight: 600;
                            cursor: pointer;
                            transition: all 0.3s ease;
                        " onmouseover="this.style.transform='translateY(-1px)'; this.style.boxShadow='0 5px 15px rgba(0, 212, 255, 0.4)'"
                           onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='none'">
                            Yes, Trust This Host
                        </button>
                        
                        <button onclick="document.getElementById('hostKeyModal').remove(); window.hostKeyResolve(false)" style="
                            background: rgba(255, 255, 255, 0.1);
                            border: 1px solid rgba(255, 255, 255, 0.2);
                            border-radius: 6px;
                            padding: 12px 24px;
                            color: white;
                            font-size: 14px;
                            font-weight: 600;
                            cursor: pointer;
                            transition: all 0.3s ease;
                        " onmouseover="this.style.background='rgba(255, 68, 68, 0.2)'"
                           onmouseout="this.style.background='rgba(255, 255, 255, 0.1)'">
                            No, Cancel Connection
                        </button>
                    </div>
                </div>
            </div>
        `;
        
        document.body.insertAdjacentHTML('beforeend', modalHTML);
        
        // Set up the resolve function
        window.hostKeyResolve = (accepted) => {
            resolve(accepted);
            delete window.hostKeyResolve;
        };
    });
}

// Copy/Paste functionality for terminals - uses Python backend for clipboard
function setupTerminalClipboard(terminal, sessionId) {
    // Handle copy/paste keyboard shortcuts
    terminal.attachCustomKeyEventHandler((event) => {
        // Check for Ctrl+Shift+C (copy)
        if (event.ctrlKey && event.shiftKey && (event.key === 'C' || event.key === 'c')) {
            if (event.type === 'keydown' && !event.repeat) {
                const selection = terminal.getSelection();
                if (selection) {
                    window.pywebview.api.clipboard_copy(selection);
                }
            }
            return false;
        }

        // Check for Ctrl+Shift+V (paste)
        if (event.ctrlKey && event.shiftKey && (event.key === 'V' || event.key === 'v')) {
            event.preventDefault();
            event.stopPropagation();
            if (event.type === 'keydown' && !event.repeat) {
                window.pywebview.api.clipboard_paste().then(result => {
                    const data = JSON.parse(result);
                    if (data.success && data.text && currentSessionId === sessionId) {
                        window.pywebview.api.send_input(sessionId, data.text);
                    }
                });
            }
            return false;
        }

        return true;
    });

    // Add right-click context menu for copy/paste
    terminal.element.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showTerminalContextMenu(e, terminal, sessionId);
    });
}

function showTerminalContextMenu(event, terminal, sessionId) {
    // Remove any existing context menu
    const existingMenu = document.getElementById('terminalContextMenu');
    if (existingMenu) {
        existingMenu.remove();
    }

    // Capture selection NOW before any click events can clear it
    const hasSelection = terminal.hasSelection();
    const capturedSelection = hasSelection ? terminal.getSelection() : '';
    
    // Create context menu
    const contextMenu = document.createElement('div');
    contextMenu.id = 'terminalContextMenu';
    contextMenu.style.cssText = `
        position: fixed;
        background: rgba(30, 30, 30, 0.95);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 8px;
        padding: 8px 0;
        min-width: 150px;
        z-index: 10000;
        backdrop-filter: blur(10px);
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
        font-family: 'Inter', sans-serif;
        font-size: 14px;
    `;
    
    // Copy option
    const copyOption = document.createElement('div');
    copyOption.style.cssText = `
        padding: 8px 16px;
        color: ${hasSelection ? '#ffffff' : '#666666'};
        cursor: ${hasSelection ? 'pointer' : 'not-allowed'};
        transition: background-color 0.2s ease;
        display: flex;
        align-items: center;
        gap: 8px;
    `;
    copyOption.innerHTML = `
        <span style="font-family: monospace;">⌘</span>
        Copy${hasSelection ? '' : ' (no selection)'}
        <span style="margin-left: auto; font-size: 12px; color: #888;">Ctrl+Shift+C</span>
    `;
    
    if (hasSelection) {
        copyOption.onmouseover = () => copyOption.style.background = 'rgba(0, 212, 255, 0.2)';
        copyOption.onmouseout = () => copyOption.style.background = 'transparent';
        copyOption.onclick = () => {
            window.pywebview.api.clipboard_copy(capturedSelection);
            contextMenu.remove();
        };
    }

    // Paste option
    const pasteOption = document.createElement('div');
    pasteOption.style.cssText = `
        padding: 8px 16px;
        color: #ffffff;
        cursor: pointer;
        transition: background-color 0.2s ease;
        display: flex;
        align-items: center;
        gap: 8px;
    `;
    pasteOption.innerHTML = `
        <span style="font-family: monospace;">📋</span>
        Paste
        <span style="margin-left: auto; font-size: 12px; color: #888;">Ctrl+Shift+V</span>
    `;
    pasteOption.onmouseover = () => pasteOption.style.background = 'rgba(0, 212, 255, 0.2)';
    pasteOption.onmouseout = () => pasteOption.style.background = 'transparent';
    pasteOption.onclick = () => {
        window.pywebview.api.clipboard_paste().then(result => {
            const data = JSON.parse(result);
            if (data.success && data.text && currentSessionId === sessionId) {
                window.pywebview.api.send_input(sessionId, data.text);
            }
        });
        contextMenu.remove();
    };
    
    // Add separator
    const separator = document.createElement('div');
    separator.style.cssText = `
        height: 1px;
        background: rgba(255, 255, 255, 0.1);
        margin: 4px 0;
    `;
    
    // Select All option
    const selectAllOption = document.createElement('div');
    selectAllOption.style.cssText = `
        padding: 8px 16px;
        color: #ffffff;
        cursor: pointer;
        transition: background-color 0.2s ease;
        display: flex;
        align-items: center;
        gap: 8px;
    `;
    selectAllOption.innerHTML = `
        <span style="font-family: monospace;">◉</span>
        Select All
        <span style="margin-left: auto; font-size: 12px; color: #888;">Ctrl+A</span>
    `;
    selectAllOption.onmouseover = () => selectAllOption.style.background = 'rgba(0, 212, 255, 0.2)';
    selectAllOption.onmouseout = () => selectAllOption.style.background = 'transparent';
    selectAllOption.onclick = () => {
        terminal.selectAll();
        contextMenu.remove();
    };
    
    // Clear option
    const clearOption = document.createElement('div');
    clearOption.style.cssText = `
        padding: 8px 16px;
        color: #ffffff;
        cursor: pointer;
        transition: background-color 0.2s ease;
        display: flex;
        align-items: center;
        gap: 8px;
    `;
    clearOption.innerHTML = `
        <span style="font-family: monospace;">🗑</span>
        Clear Terminal
        <span style="margin-left: auto; font-size: 12px; color: #888;">Ctrl+L</span>
    `;
    clearOption.onmouseover = () => clearOption.style.background = 'rgba(255, 68, 68, 0.2)';
    clearOption.onmouseout = () => clearOption.style.background = 'transparent';
    clearOption.onclick = () => {
        terminal.clear();
        contextMenu.remove();
    };
    
    // Assemble menu
    contextMenu.appendChild(copyOption);
    contextMenu.appendChild(pasteOption);
    contextMenu.appendChild(separator);
    contextMenu.appendChild(selectAllOption);
    contextMenu.appendChild(clearOption);
    
    // Position menu
    contextMenu.style.left = event.pageX + 'px';
    contextMenu.style.top = event.pageY + 'px';
    
    // Add to page
    document.body.appendChild(contextMenu);
    
    // Hide menu when clicking elsewhere
    setTimeout(() => {
        document.addEventListener('click', () => {
            if (contextMenu.parentNode) {
                contextMenu.remove();
            }
        }, { once: true });
    }, 0);
    
    // Prevent the default context menu
    event.preventDefault();
    event.stopPropagation();
}

function showCopyNotification(message, type = 'success') {
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 70px;
        right: 20px;
        background: ${type === 'error' ? 'rgba(255, 68, 68, 0.9)' : 
                    type === 'warning' ? 'rgba(255, 165, 0, 0.9)' : 
                    'rgba(0, 255, 136, 0.9)'};
        color: white;
        padding: 8px 16px;
        border-radius: 6px;
        font-size: 12px;
        z-index: 10001;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        backdrop-filter: blur(10px);
        font-family: 'Inter', sans-serif;
        animation: slideInFromRight 0.3s ease;
    `;
    
    const icon = type === 'error' ? '❌' : type === 'warning' ? '⚠️' : '✓';
    notification.textContent = `${icon} ${message}`;
    
    // Add animation keyframes if not already added
    if (!document.getElementById('copyNotificationStyles')) {
        const style = document.createElement('style');
        style.id = 'copyNotificationStyles';
        style.textContent = `
            @keyframes slideInFromRight {
                from {
                    transform: translateX(100%);
                    opacity: 0;
                }
                to {
                    transform: translateX(0);
                    opacity: 1;
                }
            }
        `;
        document.head.appendChild(style);
    }
    
    document.body.appendChild(notification);
    
    // Remove after 2 seconds
    setTimeout(() => {
        if (notification.parentNode) {
            notification.style.animation = 'slideInFromRight 0.3s ease reverse';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 300);
        }
    }, 2000);
}

// Wait for page to load
window.addEventListener('DOMContentLoaded', () => {
    console.log('Page loaded, checking Terminal availability...');

    initTerminalWorkspaceLayout();
    initSessionViewLayout();
    installSessionPaneKeyboardCycle();
    installTerminalBrowserShortcutShield();
    
    // Check if Terminal is available
    if (typeof Terminal === 'undefined') {
        console.error('Terminal library not loaded!');
        alert('Error: Terminal library failed to load. Please check your internet connection and refresh the page.');
        return;
    }
    
    console.log('Terminal library loaded successfully');
    
    // Wait for pywebview API to be ready
    function waitForAPI() {
        if (window.pywebview && window.pywebview.api) {
            console.log('PyWebView API ready, loading saved connections...');
            // Check encryption status first
            checkEncryptionStatus();
            // Load saved connections
            loadSavedConnections();
            // Setup drag and drop
            setupDragDrop();
        } else {
            console.log('Waiting for PyWebView API...');
            setTimeout(waitForAPI, 100);
        }
    }
    
    waitForAPI();

    document.addEventListener('click', (e) => {
        if (e.target.closest('.bookmark-gear-wrap')) return;
        closeBookmarkOptionMenus();
    });
    
    // Handle auth type change
    document.getElementById('authType').addEventListener('change', (e) => {
        if (e.target.value === 'password') {
            document.getElementById('passwordGroup').style.display = 'block';
            document.getElementById('keyGroup').style.display = 'none';
        } else {
            document.getElementById('passwordGroup').style.display = 'none';
            document.getElementById('keyGroup').style.display = 'block';
        }
    });
});

/**
 * Evita que o motor WebView/Chromium aplique atalhos do browser (F5 atualizar, Ctrl+R, F10 menu, etc.)
 * quando o foco está no xterm — necessário para midnight commander, less, diálogos ncurses, etc.
 */
function installTerminalBrowserShortcutShield() {
    if (window.__prismsshTermShortcutShieldInstalled) return;
    window.__prismsshTermShortcutShieldInstalled = true;

    function isXtermFocused() {
        const w = document.getElementById('terminalWrapper');
        if (!w || w.style.display === 'none') return false;
        const el = document.activeElement;
        return !!(el && el.closest && el.closest('.xterm'));
    }

    window.addEventListener(
        'keydown',
        (e) => {
            if (!isXtermFocused()) return;
            const k = e.key;

            /* Só impedir comportamento do navegador (ex.: recarregar, fechar tab). Ctrl+R/W/L ficam livres para o shell (readline). */
            if (/^F\d{1,2}$/.test(k)) {
                e.preventDefault();
                return;
            }
            /* Hard refresh só no navegador; não remover Ctrl+Shift+R do shell inadvertidamente só se combinado explicitamente pelo WebView — comum segurar apenas isto aqui para evitar recarregar a app inteira em debug. Se atrapalhar algo raro no terminal, remover este bloco. */
            if (e.ctrlKey && e.shiftKey && (k === 'R' || k === 'r')) {
                e.preventDefault();
                return;
            }
        },
        true,
    );
}

async function connect() {
    const hostname = document.getElementById('hostname').value;
    const portRaw = document.getElementById('port').value;
    const parsedPort = parseInt(portRaw, 10);
    const port =
        Number.isFinite(parsedPort) && parsedPort >= 1 && parsedPort <= 65535
            ? parsedPort
            : 22;
    const username = document.getElementById('username').value;
    const deviceName = document.getElementById('deviceName').value.trim();
    const connectionGroup = document.getElementById('connectionGroup').value.trim();
    const authType = document.getElementById('authType').value;
    const password = authType === 'password' ? document.getElementById('password').value : null;
    const keyPath = authType === 'key' ? document.getElementById('keyPath').value : null;
    const saveConnection = document.getElementById('saveConnection').checked;
    
    if (!hostname || !username) {
        alert('Please fill in hostname and username');
        return;
    }
    
    // Show connecting screen
    document.getElementById('welcomeScreen').style.display = 'none';
    document.getElementById('connectingScreen').style.display = 'block';
    
    try {
        // Create new session
        const sessionId = await window.pywebview.api.create_session();

        // Connect (with host verification if needed)
        // Nota: name e group só vão para o perfil salvo (bookmarks); o SSH usa só hostname, port, username, password/keyPath.
        const result = await connectWithHostVerification(sessionId, {
            hostname,
            port,
            username,
            name: deviceName || `${username}@${hostname}`,
            group: connectionGroup,
            password,
            keyPath,
            save: saveConnection
        });

        console.log('Connection result:', result);

        if (result.success) {
            console.log('Connection successful, creating terminal...');

            // Add basic session info first
            sessions[sessionId] = {
                id: sessionId,
                hostname,
                username,
                connected: true,
                label: deviceName.trim() ? deviceName.trim() : `${username}@${hostname}`
            };

            // Create terminal (this will update the sessions object)
            createTerminalForSession(sessionId, hostname);

            updateSessionsList();
            switchToSession(sessionId);

            // Start polling for output from all sessions (global tick)
            restartGlobalOutputPolling();

            console.log('Terminal setup complete');
        } else {
            console.error('Connection failed:', result.error);
            alert('Connection failed: ' + (result.error || 'Unknown error'));
            document.getElementById('connectingScreen').style.display = 'none';
            document.getElementById('welcomeScreen').style.display = 'flex';
        }
    } catch (error) {
        console.error('Connection error:', error);
        alert('Connection error: ' + error);
        document.getElementById('connectingScreen').style.display = 'none';
        document.getElementById('welcomeScreen').style.display = 'flex';
    } finally {
        // O backend grava o bookmark antes da tentativa SSH; atualizar lista mesmo se a conexão falhar.
        if (saveConnection) {
            try {
                await loadSavedConnections();
            } catch (_) {
                /* ignore */
            }
        }
    }
}

function createTerminalForSession(sessionId, hostname) {
    try {
        const paneRoot = document.getElementById('terminalWrapper');
        if (!paneRoot) return;

        const section = document.createElement('section');
        section.className = 'terminal-pane';
        section.dataset.sessionId = sessionId;

        const header = document.createElement('header');
        header.className = 'terminal-pane-header';
        header.innerHTML = `
            <span class="terminal-pane-title">${escapeHtml(getSessionPaneTitle(sessionId))}</span>
            <span class="terminal-pane-focus-dot" aria-hidden="true"></span>`;
        header.tabIndex = 0;
        header.onclick = () => switchToSession(sessionId);

        const body = document.createElement('div');
        body.className = 'terminal-pane-body';
        body.addEventListener('mousedown', () => switchToSession(sessionId));

        const inner = document.createElement('div');
        inner.className = 'terminal-pane-body-inner';

        const terminalElement = document.createElement('div');
        terminalElement.className = 'terminal-xterm-host';
        terminalElement.id = `terminal-host-${sessionId}`;

        inner.appendChild(terminalElement);
        body.appendChild(inner);
        section.appendChild(header);
        section.appendChild(body);
        paneRoot.appendChild(section);

        const terminal = new Terminal({
            cursorBlink: true,
            fontSize: 14,
            fontFamily: 'Consolas, "Courier New", monospace',
            theme: {
                background: '#000000',
                foreground: '#ffffff',
                cursor: '#00ff88'
            },
            scrollback: 10000,
            convertEol: true,
            windowsMode: true
        });

        let terminalFitAddon = null;
        if (typeof FitAddon !== 'undefined') {
            terminalFitAddon = new FitAddon.FitAddon();
            terminal.loadAddon(terminalFitAddon);
        }

        terminal.open(terminalElement);

        setupTerminalClipboard(terminal, sessionId);

        const calculateTerminalSize = () => {
            const rect = terminalElement.getBoundingClientRect();
            if (rect.width < 4 || rect.height < 4) return;

            const padding = 12;
            const availableHeight = Math.max(0, rect.height - padding * 2);
            const availableWidth = Math.max(0, rect.width - padding * 2);

            const charHeight = 17;
            const charWidth = 8;

            const rows = Math.floor(availableHeight / charHeight);
            const cols = Math.floor(availableWidth / charWidth);

            if (rows > 0 && cols > 0) {
                terminal.resize(cols, rows);
            }

            if (terminalFitAddon) {
                try {
                    terminalFitAddon.fit();
                } catch (e) {
                    console.error('Fit addon error:', e);
                }
            }
        };

        setTimeout(calculateTerminalSize, 50);
        setTimeout(calculateTerminalSize, 200);
        setTimeout(calculateTerminalSize, 500);

        terminal.focus();

        terminal.onData((data) => {
            if (focusedSessionId !== sessionId) return;
            if (isOptimisticChar(data)) {
                if (data.charCodeAt(0) === 127) {
                    const hasPendingChar = pendingEchoBuffer.some((e) => e.char);
                    if (hasPendingChar) {
                        for (let i = pendingEchoBuffer.length - 1; i >= 0; i--) {
                            if (pendingEchoBuffer[i].char) {
                                pendingEchoBuffer.splice(i, 1);
                                break;
                            }
                        }
                        terminal.write('\b \b');
                    }
                } else {
                    terminal.write(data);
                    pendingEchoBuffer.push({ char: data, time: Date.now() });
                }
            }
            setTimeout(() => {
                window.pywebview.api.send_input(sessionId, data);
            }, 0);
        });

        terminal.onResize(async ({ cols, rows }) => {
            console.log(`Terminal resized to ${cols}x${rows}`);
            await window.pywebview.api.resize_terminal(sessionId, cols, rows);
        });

        currentTerminal = terminal;

        const resizeObserver = new ResizeObserver(() => {
            const vis = sessionViewLayout !== 'single' || focusedSessionId === sessionId;
            if (vis) calculateTerminalSize();
        });
        resizeObserver.observe(body);

        sessions[sessionId] = {
            ...sessions[sessionId],
            terminal,
            terminalElement,
            paneSection: section,
            paneHeaderEl: header,
            paneBody: body,
            fitAddon: terminalFitAddon,
            calculateSize: calculateTerminalSize,
            resizeObserver
        };
    } catch (error) {
        console.error('Error creating terminal:', error);
        alert('Failed to create terminal: ' + error.message);
    }
}

function restartGlobalOutputPolling() {
    if (outputPollingInterval) {
        clearInterval(outputPollingInterval);
    }

    outputPollingInterval = setInterval(async () => {
        const liveIds = Object.keys(sessions).filter(
            (sid) => sessions[sid]?.terminal && sessions[sid]?.connected !== false
        );
        if (liveIds.length === 0) return;

        for (const sessionId of liveIds) {
            const shouldReadOutput =
                sessionViewLayout !== 'single' || focusedSessionId === sessionId;
            try {
                if (shouldReadOutput) {
                    const result = JSON.parse(await window.pywebview.api.get_output(sessionId));
                    if (result.output && sessions[sessionId]?.terminal) {
                        const filtered = stripPredictedEchoesFiltered(sessionId, result.output);
                        if (filtered.length > 0) {
                            sessions[sessionId].terminal.write(filtered);
                        }
                    }
                }

                const statusResult = JSON.parse(await window.pywebview.api.get_status(sessionId));
                if (!statusResult.connected) {
                    console.log(`Session ${sessionId} disconnected`);
                    handleSessionDisconnect(sessionId, false);
                }
            } catch (error) {
                console.error('Error polling output:', error);
                handleSessionDisconnect(sessionId, false);
            }
        }
    }, 50);
}

function handleSessionDisconnect(sessionId, wasLogout) {
    if (!sessions[sessionId]) return;

    console.log(`Handling disconnect for session ${sessionId}, logout: ${wasLogout}`);

    const message = wasLogout
        ? '\r\n\r\n[Session ended - User logged out]\r\n'
        : '\r\n\r\n[Session ended - Connection lost]\r\n';

    if (sessions[sessionId].terminal) {
        sessions[sessionId].terminal.write(message);
    }

    sessions[sessionId].connected = false;

    const needRefocus = focusedSessionId === sessionId || currentSessionId === sessionId;
    const others = Object.keys(sessions).filter(
        (id) => id !== sessionId && sessions[id]?.connected !== false && sessions[id]?.terminal
    );
    if (needRefocus && others.length) {
        switchToSession(others[0]);
    }

    updateSessionsList();
    applyTerminalPaneDOMVisibility();

    if (needRefocus && others.length === 0) {
        document.getElementById('statusBar').style.display = 'none';

        setTimeout(() => {
            if (!sessions[sessionId] || sessions[sessionId].connected) return;
            if (confirm('Connection lost. Would you like to reconnect?')) {
                reconnectSession(sessionId);
            } else {
                removeSession(sessionId);
            }
        }, 1000);

        setTimeout(() => {
            if (sessions[sessionId] && !sessions[sessionId].connected) {
                removeSession(sessionId);
            }
        }, 30000);
    }
}

function removeSession(sessionId) {
    console.log(`Removing session ${sessionId}`);
    
    if (sessions[sessionId]) {
        if (sessions[sessionId].resizeObserver && sessions[sessionId].resizeObserver.disconnect) {
            try {
                sessions[sessionId].resizeObserver.disconnect();
            } catch (e) {
                /* noop */
            }
        }
        
        // Cleanup terminal
        if (sessions[sessionId].terminal) {
            sessions[sessionId].terminal.dispose();
        }
        
        if (sessions[sessionId].paneSection) {
            sessions[sessionId].paneSection.remove();
        } else if (sessions[sessionId].terminalElement) {
            sessions[sessionId].terminalElement.remove();
        }
        
        delete sessions[sessionId];
        updateSessionsList();

        const remaining = getConnectedSessionsOrderedForSplit();

        const hadFocus =
            focusedSessionId === sessionId || currentSessionId === sessionId;
        const nextId = remaining[0];

        if (remaining.length === 0) {
            if (outputPollingInterval) {
                clearInterval(outputPollingInterval);
                outputPollingInterval = null;
            }
        }

        if (remaining.length === 0) {
            currentSessionId = null;
            currentTerminal = null;
            focusedSessionId = null;
            document.getElementById('terminalWrapper').style.display = 'none';
            document.getElementById('welcomeScreen').style.display = 'flex';
            document.getElementById('statusBar').style.display = 'none';
        } else if (hadFocus && nextId) {
            switchToSession(nextId);
        }
    }
}

async function reconnectSession(oldSessionId) {
    const session = sessions[oldSessionId];
    if (!session) return;
    
    console.log(`Reconnecting session ${oldSessionId}`);
    
    // Fill in connection details
    document.getElementById('hostname').value = session.hostname;
    document.getElementById('username').value = session.username;
    
    // Remove old session
    removeSession(oldSessionId);
    
    // Connect
    await connect();
}

function switchToSession(sessionId) {
    console.log(`Switching to session ${sessionId} from ${currentSessionId}`);

    if (!sessions[sessionId]) return;

    pendingEchoBuffer = [];
    focusedSessionId = sessionId;
    currentSessionId = sessionId;

    document.getElementById('welcomeScreen').style.display = 'none';
    document.getElementById('connectingScreen').style.display = 'none';
    document.getElementById('terminalWrapper').style.display = 'flex';

    document.getElementById('statusBar').style.display = 'flex';
    document.getElementById('statusHost').textContent = escapeHtml(getSessionPaneTitle(sessionId));

    applyTerminalPaneDOMVisibility();

    if (sessions[sessionId].terminal) {
        currentTerminal = sessions[sessionId].terminal;
        currentTerminal.focus();
        setTimeout(() => {
            if (sessions[sessionId].fitAddon) {
                try {
                    sessions[sessionId].fitAddon.fit();
                } catch (e) {
                    console.error('Error fitting terminal on switch:', e);
                }
            }
        }, 100);
    }

    restartGlobalOutputPolling();

    notifyTerminalViewportResize();

    updateSessionsList();
}

function updateSessionsList() {
    const container = document.getElementById('sessionsList');
    container.innerHTML = '';
    
    const sessionValues = Object.values(sessions);
    if (sessionValues.length === 0) {
        container.innerHTML = '<div class="empty-message">No active sessions</div>';
        return;
    }
    
    // Open the active sessions section if there are sessions
    if (sessionValues.length > 0) {
        document.getElementById('activeSessionsContent').classList.add('open');
        document.getElementById('activeSessionsChevron').classList.add('open');
    }
    
    sessionValues.forEach(session => {
        const item = document.createElement('div');
        const isActive = session.id === currentSessionId;
        const isConnected = session.connected !== false;
        
        item.className = 'session-item' + (isActive ? ' active' : '') + (!isConnected ? ' disconnected' : '');
        item.innerHTML = `
            <div class="session-status" style="background: ${isConnected ? '#00ff88' : '#ff4444'}"></div>
            <div class="session-info">
                <div class="session-name">${escapeHtml(session.username)}@${escapeHtml(session.hostname)}</div>
                <div class="session-host">Session ${escapeHtml(session.id.split('_')[1])} ${!isConnected ? '(Disconnected)' : ''}</div>
            </div>
            <div class="session-actions" style="opacity: 0; transition: opacity 0.2s ease;">
                ${isConnected ? 
                    '<button class="action-btn" onclick="disconnectSession(\'' + escapeJs(session.id) + '\'); event.stopPropagation();">Disconnect</button>' :
                    '<button class="action-btn" onclick="removeSession(\'' + escapeJs(session.id) + '\'); event.stopPropagation();">Remove</button>'
                }
            </div>
        `;
        
        if (isConnected) {
            item.onclick = () => switchToSession(session.id);
        } else {
            // For disconnected sessions, show reconnect option
            item.onclick = () => {
                if (confirm('This session is disconnected. Reconnect?')) {
                    reconnectSession(session.id);
                }
            };
        }
        
        // Show actions on hover
        item.onmouseenter = () => {
            const actions = item.querySelector('.session-actions');
            if (actions) actions.style.opacity = '1';
        };
        item.onmouseleave = () => {
            const actions = item.querySelector('.session-actions');
            if (actions) actions.style.opacity = '0';
        };
        
        container.appendChild(item);
    });
}

async function disconnectSession(sessionId) {
    if (confirm('Are you sure you want to disconnect this session?')) {
        console.log(`Manually disconnecting session ${sessionId}`);
        
        try {
            // Call API to disconnect
            await window.pywebview.api.disconnect(sessionId);
            
            // Handle as disconnection
            handleSessionDisconnect(sessionId, true);
        } catch (error) {
            console.error('Error disconnecting session:', error);
            // Force local disconnect
            handleSessionDisconnect(sessionId, false);
        }
    }
}

// System Monitor Functions
let systemMonitorInterval = null;
let systemMonitorData = {
    systemInfo: null,
    systemStats: null,
    processList: null,
    diskUsage: null,
    networkInfo: null
};

async function copySystemMonitorData() {
    const data = systemMonitorData;
    const timestamp = new Date().toISOString();

    let output = `=== System Monitor Report ===\n`;
    output += `Generated: ${timestamp}\n`;
    output += `Session: ${currentSessionId || 'N/A'}\n\n`;

    // System Information
    output += `--- System Information ---\n`;
    if (data.systemInfo) {
        const fields = ['os_name', 'os_version', 'hostname', 'architecture', 'cpu', 'total_memory', 'uptime'];
        fields.forEach(key => {
            if (data.systemInfo[key]) {
                const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                output += `${label}: ${data.systemInfo[key]}\n`;
            }
        });
    } else {
        output += `No data available\n`;
    }

    // Resource Usage
    output += `\n--- Resource Usage ---\n`;
    if (data.systemStats) {
        if (data.systemStats.cpu_usage) output += `CPU Usage: ${data.systemStats.cpu_usage}\n`;
        if (data.systemStats.memory_usage) {
            output += `Memory Usage: ${data.systemStats.memory_usage}`;
            if (data.systemStats.memory_used && data.systemStats.memory_total) {
                output += ` (${data.systemStats.memory_used} / ${data.systemStats.memory_total})`;
            }
            output += `\n`;
        }
        if (data.systemStats.disk_usage) {
            output += `Disk Usage: ${data.systemStats.disk_usage}`;
            if (data.systemStats.disk_used && data.systemStats.disk_total) {
                output += ` (${data.systemStats.disk_used} / ${data.systemStats.disk_total})`;
            }
            output += `\n`;
        }
    } else {
        output += `No data available\n`;
    }

    // Disk Usage
    output += `\n--- Disk Usage ---\n`;
    if (data.diskUsage && data.diskUsage.length > 0) {
        data.diskUsage.forEach(disk => {
            output += `${disk.device || disk.mount || 'Unknown'}: ${disk.usage || '0%'} used`;
            output += ` (${disk.used || '0'} / ${disk.total || '0'})`;
            if (disk.mount) output += ` mounted at ${disk.mount}`;
            output += `\n`;
        });
    } else {
        output += `No data available\n`;
    }

    // Network Interfaces
    output += `\n--- Network Interfaces ---\n`;
    if (data.networkInfo && data.networkInfo.length > 0) {
        data.networkInfo.forEach(iface => {
            output += `${iface.name || 'Unknown'}:`;
            if (iface.ip) output += ` IP=${iface.ip}`;
            if (iface.netmask) output += ` Netmask=${iface.netmask}`;
            if (iface.cidr) output += ` CIDR=${iface.cidr}`;
            output += `\n`;
        });
    } else {
        output += `No data available\n`;
    }

    // Top Processes
    output += `\n--- Top Processes ---\n`;
    if (data.processList && data.processList.length > 0) {
        const isLinux = data.processList[0] && data.processList[0].cpu !== undefined;
        if (isLinux) {
            output += `${'Name'.padEnd(25)} ${'PID'.padEnd(8)} ${'CPU'.padEnd(8)} ${'Memory'}\n`;
            output += `${'-'.repeat(55)}\n`;
        } else {
            output += `${'Name'.padEnd(25)} ${'PID'.padEnd(8)} ${'Memory'}\n`;
            output += `${'-'.repeat(45)}\n`;
        }
        data.processList.slice(0, 20).forEach(proc => {
            const name = (proc.name || 'Unknown').substring(0, 24).padEnd(25);
            const pid = String(proc.pid || '0').padEnd(8);
            if (isLinux) {
                const cpu = (proc.cpu || '0%').padEnd(8);
                const mem = proc.memory || '0%';
                output += `${name} ${pid} ${cpu} ${mem}\n`;
            } else {
                const mem = proc.memory || '0 KB';
                output += `${name} ${pid} ${mem}\n`;
            }
        });
        if (data.processList.length > 20) {
            output += `... and ${data.processList.length - 20} more processes\n`;
        }
    } else {
        output += `No data available\n`;
    }

    // Copy to clipboard
    window.pywebview.api.clipboard_copy(output);

    // Show notification
    showSyncNotification('System data copied');
}

async function initializeSystemMonitor() {
    console.log('Initializing system monitor...');
    
    // Check if we have an active session
    if (!currentSessionId || !sessions[currentSessionId]) {
        document.getElementById('systemInfo').innerHTML = '<div class="error-message">No active session. Please connect to a server first.</div>';
        return;
    }
    
    // Load initial data
    await loadSystemMonitorData();
    
    // Start auto-refresh every 5 seconds
    if (systemMonitorInterval) {
        clearInterval(systemMonitorInterval);
    }
    
    systemMonitorInterval = setInterval(async () => {
        // Only update if monitor panel is still open and we have a session
        if (document.getElementById('monitorPanel').classList.contains('active') && 
            currentSessionId && sessions[currentSessionId]) {
            await loadSystemMonitorData();
        }
    }, 5000);
}

async function loadSystemMonitorData() {
    try {
        console.log('Loading system monitor data...');
        
        // Load all data in parallel
        const [systemInfo, systemStats, processList, diskUsage, networkInfo] = await Promise.all([
            loadSystemInfo(),
            loadSystemStats(),
            loadProcessList(),
            loadDiskUsage(),
            loadNetworkInfo()
        ]);
        
        console.log('System monitor data loaded successfully');
        
    } catch (error) {
        console.error('Error loading system monitor data:', error);
    }
}

async function loadSystemInfo() {
    try {
        const response = await window.pywebview.api.get_system_info(currentSessionId);
        const result = JSON.parse(response);

        if (result.success) {
            systemMonitorData.systemInfo = result.info;
            displaySystemInfo(result.info);
        } else {
            systemMonitorData.systemInfo = null;
            document.getElementById('systemInfo').innerHTML =
                `<div class="error-message">Error: ${result.error}</div>`;
        }
    } catch (error) {
        console.error('Error loading system info:', error);
        systemMonitorData.systemInfo = null;
        document.getElementById('systemInfo').innerHTML =
            '<div class="error-message">Failed to load system information</div>';
    }
}

async function loadSystemStats() {
    try {
        const response = await window.pywebview.api.get_system_stats(currentSessionId);
        const result = JSON.parse(response);

        if (result.success) {
            systemMonitorData.systemStats = result.stats;
            displaySystemStats(result.stats);
        } else {
            systemMonitorData.systemStats = null;
            document.getElementById('systemStats').innerHTML =
                `<div class="error-message">Error: ${result.error}</div>`;
        }
    } catch (error) {
        console.error('Error loading system stats:', error);
        systemMonitorData.systemStats = null;
        document.getElementById('systemStats').innerHTML =
            '<div class="error-message">Failed to load system statistics</div>';
    }
}

async function loadProcessList() {
    try {
        const response = await window.pywebview.api.get_process_list(currentSessionId);
        const result = JSON.parse(response);

        if (result.success) {
            systemMonitorData.processList = result.processes;
            displayProcessList(result.processes);
        } else {
            systemMonitorData.processList = null;
            document.getElementById('processList').innerHTML =
                `<div class="error-message">Error: ${result.error}</div>`;
        }
    } catch (error) {
        console.error('Error loading process list:', error);
        systemMonitorData.processList = null;
        document.getElementById('processList').innerHTML =
            '<div class="error-message">Failed to load process list</div>';
    }
}

async function loadDiskUsage() {
    try {
        const response = await window.pywebview.api.get_disk_usage(currentSessionId);
        const result = JSON.parse(response);

        if (result.success) {
            systemMonitorData.diskUsage = result.disk_usage;
            displayDiskUsage(result.disk_usage);
        } else {
            systemMonitorData.diskUsage = null;
            document.getElementById('diskUsage').innerHTML =
                `<div class="error-message">Error: ${result.error}</div>`;
        }
    } catch (error) {
        console.error('Error loading disk usage:', error);
        systemMonitorData.diskUsage = null;
        document.getElementById('diskUsage').innerHTML =
            '<div class="error-message">Failed to load disk usage</div>';
    }
}

async function loadNetworkInfo() {
    try {
        const response = await window.pywebview.api.get_network_info(currentSessionId);
        const result = JSON.parse(response);

        if (result.success) {
            systemMonitorData.networkInfo = result.network_info;
            displayNetworkInfo(result.network_info);
        } else {
            systemMonitorData.networkInfo = null;
            document.getElementById('networkInfo').innerHTML =
                `<div class="error-message">Error: ${result.error}</div>`;
        }
    } catch (error) {
        console.error('Error loading network info:', error);
        systemMonitorData.networkInfo = null;
        document.getElementById('networkInfo').innerHTML =
            '<div class="error-message">Failed to load network information</div>';
    }
}

function displaySystemInfo(info) {
    const container = document.getElementById('systemInfo');
    
    if (info.error) {
        container.innerHTML = `<div class="error-message">${escapeHtml(info.error)}</div>`;
        return;
    }
    
    let html = '';
    
    const fields = [
        { key: 'os_name', label: 'Operating System' },
        { key: 'os_version', label: 'OS Version' },
        { key: 'hostname', label: 'Hostname' },
        { key: 'architecture', label: 'Architecture' },
        { key: 'cpu', label: 'CPU' },
        { key: 'total_memory', label: 'Total Memory' },
        { key: 'uptime', label: 'Uptime' }
    ];
    
    fields.forEach(field => {
        if (info[field.key]) {
            html += `
                <div class="info-item">
                    <div class="info-label">${field.label}</div>
                    <div class="info-value">${escapeHtml(String(info[field.key]))}</div>
                </div>
            `;
        }
    });
    
    container.innerHTML = html || '<div class="loading-message">No system information available</div>';
}

function displaySystemStats(stats) {
    const container = document.getElementById('systemStats');
    
    if (stats.error) {
        container.innerHTML = `<div class="error-message">${escapeHtml(stats.error)}</div>`;
        return;
    }
    
    let html = '';
    
    if (stats.cpu_usage) {
        html += `
            <div class="stat-item">
                <div class="stat-label">CPU Usage</div>
                <div class="stat-value">${escapeHtml(stats.cpu_usage)}</div>
            </div>
        `;
    }
    
    if (stats.memory_usage) {
        html += `
            <div class="stat-item">
                <div class="stat-label">Memory Usage</div>
                <div class="stat-value">${escapeHtml(stats.memory_usage)}</div>
                <div class="stat-details">${escapeHtml(stats.memory_used || '')} / ${escapeHtml(stats.memory_total || '')}</div>
            </div>
        `;
    }
    
    if (stats.disk_usage) {
        html += `
            <div class="stat-item">
                <div class="stat-label">Disk Usage</div>
                <div class="stat-value">${escapeHtml(stats.disk_usage)}</div>
                <div class="stat-details">${escapeHtml(stats.disk_used || '')} / ${escapeHtml(stats.disk_total || '')}</div>
            </div>
        `;
    }
    
    container.innerHTML = html || '<div class="loading-message">No statistics available</div>';
}

function displayProcessList(processes) {
    const container = document.getElementById('processList');
    
    if (!processes || processes.length === 0) {
        container.innerHTML = '<div class="loading-message">No processes found</div>';
        return;
    }
    
    if (processes[0] && processes[0].error) {
        container.innerHTML = `<div class="error-message">${escapeHtml(processes[0].error)}</div>`;
        return;
    }
    
    // Determine if we have Linux or Windows format
    const isLinux = processes[0] && processes[0].cpu !== undefined;
    
    let html = '<div class="process-header">';
    html += '<div>Process Name</div>';
    html += '<div>PID</div>';
    if (isLinux) {
        html += '<div>CPU</div>';
        html += '<div>Memory</div>';
    } else {
        html += '<div>Memory</div>';
        html += '<div></div>';
    }
    html += '</div>';
    
    processes.forEach(process => {
        html += '<div class="process-item">';
        html += `<div class="process-name">${escapeHtml(process.name || 'Unknown')}</div>`;
        html += `<div>${escapeHtml(String(process.pid || '0'))}</div>`;
        if (isLinux) {
            html += `<div>${escapeHtml(process.cpu || '0%')}</div>`;
            html += `<div>${escapeHtml(process.memory || '0%')}</div>`;
        } else {
            html += `<div>${escapeHtml(process.memory || '0 KB')}</div>`;
            html += '<div></div>';
        }
        html += '</div>';
    });
    
    container.innerHTML = html;
}

function displayDiskUsage(disks) {
    const container = document.getElementById('diskUsage');
    
    if (!disks || disks.length === 0) {
        container.innerHTML = '<div class="loading-message">No disk information found</div>';
        return;
    }
    
    if (disks[0] && disks[0].error) {
        container.innerHTML = `<div class="error-message">${escapeHtml(disks[0].error)}</div>`;
        return;
    }
    
    let html = '';
    
    disks.forEach(disk => {
        const usagePercent = parseFloat(disk.usage?.replace('%', '') || '0');
        const displayName = disk.device || disk.mount || 'Unknown';
        
        html += `
            <div class="disk-item">
                <div class="disk-header">
                    <div class="disk-name">${escapeHtml(displayName)}</div>
                    <div class="disk-usage-percent">${escapeHtml(disk.usage || '0%')}</div>
                </div>
                <div class="disk-bar">
                    <div class="disk-bar-fill" style="width: ${Math.min(usagePercent, 100)}%"></div>
                </div>
                <div class="disk-details">
                    <span>Used: ${escapeHtml(disk.used || '0')}</span>
                    <span>Free: ${escapeHtml(disk.free || '0')}</span>
                    <span>Total: ${escapeHtml(disk.total || '0')}</span>
                </div>
                ${disk.mount ? `<div style="font-size: 11px; color: #666; margin-top: 4px;">Mounted at: ${escapeHtml(disk.mount)}</div>` : ''}
            </div>
        `;
    });
    
    container.innerHTML = html;
}

function displayNetworkInfo(interfaces) {
    const container = document.getElementById('networkInfo');
    
    if (!interfaces || interfaces.length === 0) {
        container.innerHTML = '<div class="loading-message">No network interfaces found</div>';
        return;
    }
    
    if (interfaces[0] && interfaces[0].error) {
        container.innerHTML = `<div class="error-message">${escapeHtml(interfaces[0].error)}</div>`;
        return;
    }
    
    let html = '';
    
    interfaces.forEach(iface => {
        html += `
            <div class="network-item">
                <div class="network-name">${escapeHtml(iface.name || 'Unknown Interface')}</div>
                <div class="network-details">
                    ${iface.ip ? `
                        <div class="network-detail">
                            <span class="network-detail-label">IP Address:</span>
                            <span class="network-detail-value">${escapeHtml(iface.ip)}</span>
                        </div>
                    ` : ''}
                    ${iface.netmask ? `
                        <div class="network-detail">
                            <span class="network-detail-label">Netmask:</span>
                            <span class="network-detail-value">${escapeHtml(iface.netmask)}</span>
                        </div>
                    ` : ''}
                    ${iface.cidr ? `
                        <div class="network-detail">
                            <span class="network-detail-label">CIDR:</span>
                            <span class="network-detail-value">${escapeHtml(iface.cidr)}</span>
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
    });
    
    container.innerHTML = html;
}

async function refreshSystemMonitor() {
    console.log('Refreshing system monitor...');
    
    // Reset all sections to loading state
    document.getElementById('systemInfo').innerHTML = '<div class="loading-message">Loading system information...</div>';
    document.getElementById('systemStats').innerHTML = '<div class="loading-message">Loading resource statistics...</div>';
    document.getElementById('processList').innerHTML = '<div class="loading-message">Loading process list...</div>';
    document.getElementById('diskUsage').innerHTML = '<div class="loading-message">Loading disk information...</div>';
    document.getElementById('networkInfo').innerHTML = '<div class="loading-message">Loading network information...</div>';
    
    // Load fresh data
    await loadSystemMonitorData();
}

// Cleanup system monitor when tool panel is closed
const originalCloseToolPanel = closeToolPanel;
closeToolPanel = function() {
    if (systemMonitorInterval) {
        clearInterval(systemMonitorInterval);
        systemMonitorInterval = null;
    }
    originalCloseToolPanel();
};

// Port Forwarding Functions
let currentForwardType = 'local';

async function initializePortForwarding() {
    console.log('Initializing port forwarding...');
    currentForwardType = 'local';
    selectForwardType('local');
    await refreshPortForwards();
}

function selectForwardType(type) {
    currentForwardType = type;
    
    // Update tab appearance
    document.querySelectorAll('.forward-tab').forEach(tab => {
        tab.classList.remove('active');
    });
    document.getElementById(type + 'Tab').classList.add('active');
    
    // Show/hide forms
    document.getElementById('localForm').style.display = type === 'local' ? 'block' : 'none';
    document.getElementById('remoteForm').style.display = type === 'remote' ? 'block' : 'none';
    document.getElementById('dynamicForm').style.display = type === 'dynamic' ? 'block' : 'none';
}

async function createPortForward(type) {
    if (!currentSessionId || !sessions[currentSessionId]) {
        alert('Please connect to a server first');
        return;
    }
    
    try {
        let result;
        
        if (type === 'local') {
            const localPort = parseInt(document.getElementById('localPort').value);
            const remoteHost = document.getElementById('remoteHost').value;
            const remotePort = parseInt(document.getElementById('remotePort').value);
            
            if (!localPort || !remoteHost || !remotePort) {
                alert('Please fill in all fields');
                return;
            }
            
            if (localPort < 1 || localPort > 65535 || remotePort < 1 || remotePort > 65535) {
                alert('Port numbers must be between 1 and 65535');
                return;
            }
            
            result = await window.pywebview.api.create_local_port_forward(
                currentSessionId, localPort, remoteHost, remotePort
            );
            
            // Clear form on success
            if (JSON.parse(result).success) {
                document.getElementById('localPort').value = '';
                document.getElementById('remotePort').value = '';
            }
            
        } else if (type === 'remote') {
            const remotePort = parseInt(document.getElementById('remotePortR').value);
            const localHost = document.getElementById('localHost').value;
            const localPort = parseInt(document.getElementById('localPortR').value);
            
            if (!remotePort || !localHost || !localPort) {
                alert('Please fill in all fields');
                return;
            }
            
            if (remotePort < 1 || remotePort > 65535 || localPort < 1 || localPort > 65535) {
                alert('Port numbers must be between 1 and 65535');
                return;
            }
            
            result = await window.pywebview.api.create_remote_port_forward(
                currentSessionId, remotePort, localHost, localPort
            );
            
            // Clear form on success
            if (JSON.parse(result).success) {
                document.getElementById('remotePortR').value = '';
                document.getElementById('localPortR').value = '';
            }
            
        } else if (type === 'dynamic') {
            const socksPort = parseInt(document.getElementById('socksPort').value);
            
            if (!socksPort) {
                alert('Please enter a SOCKS proxy port');
                return;
            }
            
            if (socksPort < 1 || socksPort > 65535) {
                alert('Port number must be between 1 and 65535');
                return;
            }
            
            result = await window.pywebview.api.create_dynamic_port_forward(
                currentSessionId, socksPort
            );
            
            // Clear form on success
            if (JSON.parse(result).success) {
                document.getElementById('socksPort').value = '';
            }
        }
        
        const response = JSON.parse(result);
        if (response.success) {
            console.log(`Created ${type} port forward:`, response.forward_id);
            await refreshPortForwards();
        } else {
            alert(`Failed to create port forward: ${response.error}`);
        }
        
    } catch (error) {
        console.error('Error creating port forward:', error);
        alert('Error creating port forward: ' + error.message);
    }
}

async function stopPortForward(forwardId) {
    if (!currentSessionId || !sessions[currentSessionId]) {
        return;
    }
    
    try {
        const result = await window.pywebview.api.stop_port_forward(currentSessionId, forwardId);
        const response = JSON.parse(result);
        
        if (response.success) {
            console.log('Stopped port forward:', forwardId);
            await refreshPortForwards();
        } else {
            alert('Failed to stop port forward');
        }
    } catch (error) {
        console.error('Error stopping port forward:', error);
        alert('Error stopping port forward: ' + error.message);
    }
}

async function refreshPortForwards() {
    if (!currentSessionId || !sessions[currentSessionId]) {
        document.getElementById('forwardsList').innerHTML = '<div class="loading-message">No active session</div>';
        return;
    }
    
    try {
        const result = await window.pywebview.api.list_port_forwards(currentSessionId);
        const response = JSON.parse(result);
        
        if (response.success) {
            displayPortForwards(response.forwards);
        } else {
            document.getElementById('forwardsList').innerHTML = '<div class="error-message">Failed to load port forwards</div>';
        }
    } catch (error) {
        console.error('Error loading port forwards:', error);
        document.getElementById('forwardsList').innerHTML = '<div class="error-message">Error loading port forwards</div>';
    }
}

function displayPortForwards(forwards) {
    const forwardsList = document.getElementById('forwardsList');
    
    if (!forwards || forwards.length === 0) {
        forwardsList.innerHTML = '<div class="loading-message">No active port forwards</div>';
        return;
    }
    
    const forwardsHtml = forwards.map(forward => {
        const typeClass = forward.type === 'local' ? 'local' : forward.type === 'remote' ? 'remote' : 'dynamic';
        const isActive = forward.active;
        const connections = forward.connections || 0;
        
        return `
            <div class="forward-item">
                <div class="forward-header">
                    <span class="forward-type ${typeClass}">${forward.type.toUpperCase()}</span>
                    <button class="forward-delete" onclick="stopPortForward('${forward.id}')" title="Stop forward">×</button>
                </div>
                <div class="forward-description">${escapeHtml(forward.description)}</div>
                <div class="forward-status">
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <div class="forward-status-indicator" style="background: ${isActive ? '#00ff88' : '#ff4444'};"></div>
                        <span>${isActive ? 'Active' : 'Inactive'}</span>
                    </div>
                    <span class="forward-connections">${connections} connection${connections !== 1 ? 's' : ''}</span>
                </div>
            </div>
        `;
    }).join('');
    
    forwardsList.innerHTML = forwardsHtml;
}

// Window resize handling — atualiza todas as sessões com painéis visíveis
window.addEventListener('resize', () => {
    setTimeout(() => notifyTerminalViewportResize(), 100);
});