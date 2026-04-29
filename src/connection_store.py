"""Connection storage and encryption management for PrismSSH."""

import json
import os
import base64
from typing import Dict, Any, Optional
from pathlib import Path

# Handle imports - try relative first, then absolute
try:
    from .config import Config
    from .logger import Logger
    from .exceptions import EncryptionError, ConfigurationError
except ImportError:
    from config import Config
    from logger import Logger
    from exceptions import EncryptionError, ConfigurationError

try:
    from cryptography.fernet import Fernet
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    ENCRYPTION_AVAILABLE = True
except ImportError:
    ENCRYPTION_AVAILABLE = False


class ConnectionStore:
    """Manages saved SSH connections with optional encrypted password storage."""
    
    def __init__(self, config: Config):
        self.config = config
        self.logger = Logger.get_logger(__name__)
        self.cipher = self._get_cipher() if ENCRYPTION_AVAILABLE else None
        self.encryption_warning_shown = False
        
        if not ENCRYPTION_AVAILABLE:
            self.logger.warning(
                "Cryptography package not installed. Passwords will be stored in plain text. "
                "Install with: pip install cryptography"
            )
        
        self._ensure_config_dir()
    
    def get_encryption_status(self) -> dict:
        """Get encryption status for frontend warning."""
        return {
            'available': ENCRYPTION_AVAILABLE,
            'warning_needed': not ENCRYPTION_AVAILABLE and not self.encryption_warning_shown
        }
    
    def mark_encryption_warning_shown(self):
        """Mark that the encryption warning has been shown to the user."""
        self.encryption_warning_shown = True
    
    def _ensure_config_dir(self) -> bool:
        """Create config directory if it doesn't exist."""
        try:
            Path(self.config.config_dir).mkdir(
                mode=self.config.config_dir_permissions,
                parents=True,
                exist_ok=True
            )
            return True
        except Exception as e:
            self.logger.error(f"Error creating config directory: {e}")
            raise ConfigurationError(f"Failed to create config directory: {e}")
    
    def _get_cipher(self) -> Optional[Fernet]:
        """Get or create encryption cipher for passwords."""
        if not ENCRYPTION_AVAILABLE:
            return None
            
        try:
            key_info_file = Path(self.config.config_dir) / ".key_info"

            if Path(self.config.key_file).exists() and key_info_file.exists():
                # Load existing key and salt
                with open(self.config.key_file, 'rb') as f:
                    key = f.read()
                with open(key_info_file, 'rb') as f:
                    stored_salt = f.read()
            else:
                # Generate a new key with random salt and passphrase
                salt = os.urandom(32)  # Use 32-byte salt
                
                # Generate a random passphrase for this installation
                random_passphrase = base64.urlsafe_b64encode(os.urandom(32)).decode('utf-8')
                
                kdf = PBKDF2HMAC(
                    algorithm=hashes.SHA256(),
                    length=32,
                    salt=salt,
                    iterations=self.config.encryption_key_iterations,
                )
                key_material = kdf.derive(random_passphrase.encode())
                key = base64.urlsafe_b64encode(key_material)
                
                # Save key and salt info
                with open(self.config.key_file, 'wb') as f:
                    f.write(key)
                os.chmod(self.config.key_file, self.config.key_file_permissions)
                
                with open(key_info_file, 'wb') as f:
                    f.write(salt)
                os.chmod(key_info_file, self.config.key_file_permissions)
                
                self.logger.info("Generated new encryption key with random passphrase")
            
            return Fernet(key)
        except Exception as e:
            self.logger.error(f"Error setting up encryption: {e}")
            raise EncryptionError(f"Failed to setup encryption: {e}")

    def _prepare_connection_for_storage(self, connection: Dict[str, Any]) -> Dict[str, Any]:
        """Return a copy that is safe to write to disk."""
        stored_connection = dict(connection)

        if self.cipher and stored_connection.get('password'):
            try:
                stored_connection['password'] = self.cipher.encrypt(
                    stored_connection['password'].encode()
                ).decode()
                stored_connection['password_encrypted'] = True
            except Exception as e:
                self.logger.error(f"Error encrypting password: {e}")
                stored_connection['password_encrypted'] = False

        return stored_connection

    def _write_connections(self, connections: Dict[str, Any]) -> None:
        """Persist connections, encrypting sensitive fields when possible."""
        self._ensure_config_dir()
        safe_connections = {
            key: self._prepare_connection_for_storage(connection)
            for key, connection in connections.items()
        }

        with open(self.config.connections_file, 'w') as f:
            json.dump(safe_connections, f, indent=2)

    def _normalize_group_name(self, name: str) -> str:
        """Normalize group names for stable storage and UI matching."""
        return (name or '').strip()
    
    def save_connection(self, connection: Dict[str, Any]) -> bool:
        """Save a connection profile."""
        try:
            connections = self.load_connections()

            # Use hostname@username as key
            key = f"{connection['hostname']}@{connection['username']}"
            existing = connections.get(key, {})
            connections[key] = {
                **existing,
                **connection,
                'group': connection.get('group', existing.get('group', ''))
            }

            self._write_connections(connections)

            self.logger.info(f"Connection saved: {key}")
            return True
            
        except Exception as e:
            self.logger.error(f"Error saving connection: {e}")
            return False
    
    def load_connections(self) -> Dict[str, Any]:
        """Load all saved connections."""
        if not Path(self.config.connections_file).exists():
            return {}
        
        try:
            with open(self.config.connections_file, 'r') as f:
                connections = json.load(f)
            
            # Decrypt passwords if cipher is available
            for key, conn in connections.items():
                if conn.get('password_encrypted') and conn.get('password') and self.cipher:
                    try:
                        conn['password'] = self.cipher.decrypt(
                            conn['password'].encode()
                        ).decode()
                    except Exception as e:
                        self.logger.error(f"Error decrypting password for {key}: {e}")
                        # If decryption fails, remove the password
                        conn['password'] = ''
                    conn.pop('password_encrypted', None)
                elif conn.get('password_encrypted') and not self.cipher:
                    # Encrypted password but no cipher available
                    self.logger.warning(
                        f"Cannot decrypt password for {key} (install cryptography package)"
                    )
                    conn['password'] = ''
                    conn.pop('password_encrypted', None)
            
            return connections
        except Exception as e:
            self.logger.error(f"Error loading connections: {e}")
            return {}
    
    def delete_connection(self, key: str) -> bool:
        """Delete a saved connection."""
        try:
            connections = self.load_connections()
            if key in connections:
                del connections[key]
                self._write_connections(connections)
                self.logger.info(f"Connection deleted: {key}")
                return True
            else:
                self.logger.warning(f"Connection not found: {key}")
                return False
        except Exception as e:
            self.logger.error(f"Error deleting connection: {e}")
            return False
    
    def get_connection(self, key: str) -> Optional[Dict[str, Any]]:
        """Get a specific connection by key."""
        connections = self.load_connections()
        return connections.get(key)

    def rename_connection(self, key: str, new_name: str) -> bool:
        """Rename a saved connection display name without changing SSH settings."""
        try:
            normalized_name = (new_name or '').strip()
            if not normalized_name:
                self.logger.warning("Cannot rename connection to an empty name")
                return False

            connections = self.load_connections()
            if key not in connections:
                self.logger.warning(f"Connection not found: {key}")
                return False

            connections[key]['name'] = normalized_name
            self._write_connections(connections)
            self.logger.info(f"Connection renamed: {key} -> {normalized_name}")
            return True
        except Exception as e:
            self.logger.error(f"Error renaming connection {key}: {e}")
            return False

    def update_connection_group(self, key: str, group_name: str) -> bool:
        """Assign a saved connection to a group or clear its group."""
        try:
            normalized_group = self._normalize_group_name(group_name)
            connections = self.load_connections()
            if key not in connections:
                self.logger.warning(f"Connection not found: {key}")
                return False

            if normalized_group:
                self.save_group(normalized_group)

            connections[key]['group'] = normalized_group
            self._write_connections(connections)
            self.logger.info(f"Connection group updated: {key} -> {normalized_group or 'Ungrouped'}")
            return True
        except Exception as e:
            self.logger.error(f"Error updating group for {key}: {e}")
            return False

    def load_groups(self) -> list[str]:
        """Load saved host groups."""
        if not Path(self.config.connection_groups_file).exists():
            return []

        try:
            with open(self.config.connection_groups_file, 'r') as f:
                data = json.load(f)

            if isinstance(data, list):
                groups = data
            else:
                groups = data.get('groups', [])

            normalized_groups = []
            seen = set()
            for group in groups:
                normalized = self._normalize_group_name(str(group))
                key = normalized.lower()
                if normalized and key not in seen:
                    normalized_groups.append(normalized)
                    seen.add(key)

            return normalized_groups
        except Exception as e:
            self.logger.error(f"Error loading groups: {e}")
            return []

    def _write_groups(self, groups: list[str]) -> None:
        """Persist host groups in a stable shape."""
        self._ensure_config_dir()
        normalized_groups = sorted(
            {self._normalize_group_name(group) for group in groups if self._normalize_group_name(group)},
            key=str.lower
        )
        with open(self.config.connection_groups_file, 'w') as f:
            json.dump({'groups': normalized_groups}, f, indent=2)

    def save_group(self, group_name: str) -> bool:
        """Create a host group if it does not exist."""
        try:
            normalized_group = self._normalize_group_name(group_name)
            if not normalized_group:
                return False

            groups = self.load_groups()
            if normalized_group.lower() not in {group.lower() for group in groups}:
                groups.append(normalized_group)
                self._write_groups(groups)
                self.logger.info(f"Group saved: {normalized_group}")

            return True
        except Exception as e:
            self.logger.error(f"Error saving group {group_name}: {e}")
            return False

    def rename_group(self, old_name: str, new_name: str) -> bool:
        """Rename a group path (including its subgroups) and update assigned connections."""
        try:
            old_group = self._normalize_group_name(old_name)
            new_group = self._normalize_group_name(new_name)
            if not old_group or not new_group:
                return False

            groups = self.load_groups()
            if old_group.lower() not in {group.lower() for group in groups}:
                return False

            old_group_lower = old_group.lower()
            updated_groups = []
            for group in groups:
                normalized_group = self._normalize_group_name(group)
                normalized_group_lower = normalized_group.lower()
                if normalized_group_lower == old_group_lower:
                    updated_groups.append(new_group)
                elif normalized_group_lower.startswith(old_group_lower + '/'):
                    suffix = normalized_group[len(old_group):]
                    updated_groups.append(f"{new_group}{suffix}")
                else:
                    updated_groups.append(normalized_group)
            self._write_groups(updated_groups)

            connections = self.load_connections()
            for connection in connections.values():
                connection_group = self._normalize_group_name(connection.get('group', ''))
                connection_group_lower = connection_group.lower()
                if connection_group_lower == old_group_lower:
                    connection['group'] = new_group
                elif connection_group_lower.startswith(old_group_lower + '/'):
                    suffix = connection_group[len(old_group):]
                    connection['group'] = f"{new_group}{suffix}"
            self._write_connections(connections)

            self.logger.info(f"Group renamed: {old_group} -> {new_group}")
            return True
        except Exception as e:
            self.logger.error(f"Error renaming group {old_name}: {e}")
            return False

    def delete_group(self, group_name: str) -> bool:
        """Delete a group path (including subgroups) and move its connections to Ungrouped."""
        try:
            normalized_group = self._normalize_group_name(group_name)
            if not normalized_group:
                return False

            normalized_group_lower = normalized_group.lower()
            groups = [
                group for group in self.load_groups()
                if not (
                    group.lower() == normalized_group_lower
                    or group.lower().startswith(normalized_group_lower + '/')
                )
            ]
            self._write_groups(groups)

            connections = self.load_connections()
            for connection in connections.values():
                connection_group = self._normalize_group_name(connection.get('group', ''))
                connection_group_lower = connection_group.lower()
                if (
                    connection_group_lower == normalized_group_lower
                    or connection_group_lower.startswith(normalized_group_lower + '/')
                ):
                    connection['group'] = ''
            self._write_connections(connections)

            self.logger.info(f"Group deleted: {normalized_group}")
            return True
        except Exception as e:
            self.logger.error(f"Error deleting group {group_name}: {e}")
            return False