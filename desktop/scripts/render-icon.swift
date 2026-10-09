// Draws the app icon from the landing page's mark (assets/head.svg) on Apple's icon grid:
// the tile fills 824 of 1024 points, with a soft shadow under it.
// Usage: swift scripts/render-icon.swift ../assets/head.svg build/icon.png
import AppKit

let arguments = CommandLine.arguments
guard arguments.count == 3, let mark = NSImage(contentsOfFile: arguments[1]) else {
    FileHandle.standardError.write("Usage: swift render-icon.swift <head.svg> <icon.png>\n".data(using: .utf8)!)
    exit(2)
}

let canvas = 1024
guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: canvas, pixelsHigh: canvas, bitsPerSample: 8, samplesPerPixel: 4,
    hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
) else { exit(1) }
bitmap.size = NSSize(width: canvas, height: canvas)

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSGraphicsContext.current?.imageInterpolation = .high
let shadow = NSShadow()
shadow.shadowColor = NSColor.black.withAlphaComponent(0.28)
shadow.shadowOffset = NSSize(width: 0, height: -10)
shadow.shadowBlurRadius = 20
shadow.set()
mark.draw(in: NSRect(x: 100, y: 100, width: 824, height: 824))
NSGraphicsContext.restoreGraphicsState()

guard let png = bitmap.representation(using: .png, properties: [:]) else { exit(1) }
try png.write(to: URL(fileURLWithPath: arguments[2]))
print(arguments[2])
