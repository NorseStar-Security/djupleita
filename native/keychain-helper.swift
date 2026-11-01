import Foundation
import Security

// The credential itself is confined to the process pipe and the user's Keychain.
func run() throws {
    guard let line = readLine(), let bytes = line.data(using: .utf8),
          let input = try JSONSerialization.jsonObject(with: bytes) as? [String: String],
          let operation = input["operation"], let reference = input["reference"], !reference.isEmpty else {
        throw NSError(domain: "dsh-pentest", code: 1)
    }
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.dsh-pentest.identities",
        kSecAttrAccount as String: reference
    ]
    var response: [String: String] = [:]
    switch operation {
    case "get":
        var lookup = query
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var found: CFTypeRef?
        let status = SecItemCopyMatching(lookup as CFDictionary, &found)
        if status == errSecSuccess, let data = found as? Data, let value = String(data: data, encoding: .utf8) {
            response["value"] = value
        } else if status != errSecItemNotFound {
            throw NSError(domain: "dsh-pentest-keychain", code: Int(status))
        }
    case "set":
        guard let value = input["value"]?.data(using: .utf8) else { throw NSError(domain: "dsh-pentest", code: 2) }
        let update = [kSecValueData as String: value]
        let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item[kSecValueData as String] = value
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            let added = SecItemAdd(item as CFDictionary, nil)
            guard added == errSecSuccess else { throw NSError(domain: "dsh-pentest-keychain", code: Int(added)) }
        } else if status != errSecSuccess {
            throw NSError(domain: "dsh-pentest-keychain", code: Int(status))
        }
    case "remove":
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw NSError(domain: "dsh-pentest-keychain", code: Int(status))
        }
    default: throw NSError(domain: "dsh-pentest", code: 3)
    }
    let result = try JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])
    FileHandle.standardOutput.write(result)
}

do { try run() } catch { exit(1) }
