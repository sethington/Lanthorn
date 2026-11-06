import CoreGraphics
let l = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
var best = 0; var area = 0.0
for w in l { if (w[kCGWindowOwnerName as String] as? String ?? "").lowercased().contains("lanthorn") { let b = w[kCGWindowBounds as String] as! [String: Double]; let a = b["Width"]! * b["Height"]!; if a > area { area = a; best = w[kCGWindowNumber as String] as! Int } } }
print(best)
