// Frame encoder for the launch video, built on macOS AVFoundation (no ffmpeg needed).
//
//   encode <fps> <out.mp4> <WxH[@fps]> <bitsPerSecond> [<out.mp4> <WxH[@fps]> <bitsPerSecond> ...]
//       Reads length-prefixed PNG/JPEG frames from stdin (4-byte big-endian size, then bytes)
//       and writes one H.264 MP4 per output, scaling frames when the sizes differ. An output may
//       use a lower frame rate that divides the input's, for example 1280x720@30 from 60 fps.
//   encode mux <video.mp4> <audio.m4a> <out.mp4>
//       Combines a video track and an AAC audio track without re-encoding.
//   encode still <video.mp4> <seconds> <out.png>
//       Extracts one decoded frame, for checking the encoded result.

import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

func readExactly(_ count: Int) -> [UInt8]? {
  var bytes = [UInt8](repeating: 0, count: count)
  let read = bytes.withUnsafeMutableBytes { fread($0.baseAddress, 1, count, stdin) }
  if read == 0 { return nil }
  if read != count { fail("Truncated frame stream") }
  return bytes
}

func parseSize(_ text: String, inputFps: Int) -> (Int, Int, Int) {
  let sizeAndRate = text.split(separator: "@")
  let parts = sizeAndRate[0].split(separator: "x").compactMap { Int($0) }
  guard parts.count == 2, parts[0] > 0, parts[1] > 0 else { fail("Invalid size \(text); expected WxH or WxH@fps") }
  let fps = sizeAndRate.count > 1 ? Int(sizeAndRate[1]) ?? 0 : inputFps
  guard fps > 0, inputFps % fps == 0 else { fail("Output rate in \(text) must divide the input rate \(inputFps)") }
  return (parts[0], parts[1], fps)
}

// Chrome renders sRGB. Tagging the sRGB transfer function (rather than BT.709's) keeps color-managed
// players such as QuickTime and Safari from brightening the shadows; the primaries are shared.
let srgbColor: [String: Any] = [
  AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
  AVVideoTransferFunctionKey: AVVideoTransferFunction_IEC_sRGB,
  AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
]

final class Output {
  let writer: AVAssetWriter
  let input: AVAssetWriterInput
  let adaptor: AVAssetWriterInputPixelBufferAdaptor
  let width: Int
  let height: Int
  let fps: Int
  let stride: Int

  init(path: String, width: Int, height: Int, bitRate: Int, fps: Int, inputFps: Int) {
    let url = URL(fileURLWithPath: path)
    try? FileManager.default.removeItem(at: url)
    do {
      writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    } catch {
      fail("Cannot create \(path): \(error.localizedDescription)")
    }
    writer.shouldOptimizeForNetworkUse = true
    self.width = width
    self.height = height
    self.fps = fps
    stride = inputFps / fps
    input = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: width,
      AVVideoHeightKey: height,
      AVVideoColorPropertiesKey: srgbColor,
      AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: bitRate,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        AVVideoH264EntropyModeKey: AVVideoH264EntropyModeCABAC,
        AVVideoExpectedSourceFrameRateKey: fps,
        AVVideoMaxKeyFrameIntervalKey: fps * 2,
        AVVideoAllowFrameReorderingKey: true,
      ],
    ])
    input.expectsMediaDataInRealTime = false
    adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
      kCVPixelBufferWidthKey as String: width,
      kCVPixelBufferHeightKey as String: height,
    ])
    writer.add(input)
    guard writer.startWriting() else { fail("Cannot start \(path): \(writer.error?.localizedDescription ?? "unknown error")") }
    writer.startSession(atSourceTime: .zero)
  }

  func append(_ image: CGImage, frame: Int64) {
    guard frame % Int64(stride) == 0 else { return }
    let time = CMTime(value: frame / Int64(stride), timescale: CMTimeScale(fps))
    while !input.isReadyForMoreMediaData { usleep(500) }
    var pixelBuffer: CVPixelBuffer?
    guard let pool = adaptor.pixelBufferPool,
          CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pixelBuffer) == kCVReturnSuccess,
          let buffer = pixelBuffer else { fail("Cannot allocate a pixel buffer") }
    CVBufferSetAttachment(buffer, kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_ITU_R_709_2, .shouldPropagate)
    CVBufferSetAttachment(buffer, kCVImageBufferTransferFunctionKey, kCVImageBufferTransferFunction_sRGB, .shouldPropagate)
    CVBufferSetAttachment(buffer, kCVImageBufferYCbCrMatrixKey, kCVImageBufferYCbCrMatrix_ITU_R_709_2, .shouldPropagate)
    CVPixelBufferLockBaseAddress(buffer, [])
    // Drawing in the frame's own color space avoids any color conversion of the rendered pixels.
    let space = image.colorSpace?.model == .rgb ? image.colorSpace! : CGColorSpace(name: CGColorSpace.sRGB)!
    guard let context = CGContext(
      data: CVPixelBufferGetBaseAddress(buffer), width: width, height: height, bitsPerComponent: 8,
      bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: space,
      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    ) else { fail("Cannot create a drawing context") }
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    CVPixelBufferUnlockBaseAddress(buffer, [])
    if !adaptor.append(buffer, withPresentationTime: time) {
      fail("Cannot append frame: \(writer.error?.localizedDescription ?? "unknown error")")
    }
  }

  func finish(frames: Int64) {
    input.markAsFinished()
    writer.endSession(atSourceTime: CMTime(value: (frames + Int64(stride) - 1) / Int64(stride), timescale: CMTimeScale(fps)))
    let done = DispatchSemaphore(value: 0)
    writer.finishWriting { done.signal() }
    done.wait()
    if writer.status != .completed { fail("Encoding failed: \(writer.error?.localizedDescription ?? "unknown error")") }
  }
}

func encode(_ args: [String]) {
  guard args.count >= 4, (args.count - 1) % 3 == 0, let fps = Int(args[0]), fps > 0 else {
    fail("Usage: encode <fps> <out.mp4> <WxH[@fps]> <bitsPerSecond> [...]")
  }
  var outputs: [Output] = []
  for i in stride(from: 1, to: args.count, by: 3) {
    let (width, height, outputFps) = parseSize(args[i + 1], inputFps: fps)
    guard let bitRate = Int(args[i + 2]), bitRate > 0 else { fail("Invalid bit rate \(args[i + 2])") }
    outputs.append(Output(path: args[i], width: width, height: height, bitRate: bitRate, fps: outputFps, inputFps: fps))
  }
  var frames: Int64 = 0
  while let header = readExactly(4) {
    let size = Int(header[0]) << 24 | Int(header[1]) << 16 | Int(header[2]) << 8 | Int(header[3])
    guard let bytes = readExactly(size) else { fail("Truncated frame stream") }
    guard let source = CGImageSourceCreateWithData(Data(bytes) as CFData, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fail("Frame \(frames) is not an image") }
    for output in outputs { output.append(image, frame: frames) }
    frames += 1
  }
  guard frames > 0 else { fail("No frames received") }
  for output in outputs { output.finish(frames: frames) }
  print("Encoded \(frames) frames at \(fps) fps")
}

func mux(videoPath: String, audioPath: String, outPath: String) async {
  do {
    let video = AVURLAsset(url: URL(fileURLWithPath: videoPath))
    let audio = AVURLAsset(url: URL(fileURLWithPath: audioPath))
    guard let videoTrack = try await video.loadTracks(withMediaType: .video).first else { fail("No video track in \(videoPath)") }
    guard let audioTrack = try await audio.loadTracks(withMediaType: .audio).first else { fail("No audio track in \(audioPath)") }
    let duration = try await video.load(.duration)
    let audioDuration = try await audio.load(.duration)
    let composition = AVMutableComposition()
    let compositionVideo = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)!
    try compositionVideo.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: videoTrack, at: .zero)
    let compositionAudio = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
    try compositionAudio.insertTimeRange(CMTimeRange(start: .zero, duration: CMTimeMinimum(duration, audioDuration)), of: audioTrack, at: .zero)
    let url = URL(fileURLWithPath: outPath)
    try? FileManager.default.removeItem(at: url)
    guard let export = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough) else {
      fail("Cannot create an export session")
    }
    export.shouldOptimizeForNetworkUse = true
    try await export.export(to: url, as: .mp4)
    print("Wrote \(outPath)")
  } catch {
    fail("Mux failed: \(error.localizedDescription)")
  }
}

func still(videoPath: String, seconds: Double, outPath: String) async {
  do {
    let generator = AVAssetImageGenerator(asset: AVURLAsset(url: URL(fileURLWithPath: videoPath)))
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = .zero
    let (image, _) = try await generator.image(at: CMTime(seconds: seconds, preferredTimescale: 600))
    guard let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: outPath) as CFURL, UTType.png.identifier as CFString, 1, nil) else {
      fail("Cannot write \(outPath)")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { fail("Cannot write \(outPath)") }
    print("Wrote \(outPath)")
  } catch {
    fail("Still extraction failed: \(error.localizedDescription)")
  }
}

let arguments = Array(CommandLine.arguments.dropFirst())
switch arguments.first {
case "mux":
  guard arguments.count == 4 else { fail("Usage: encode mux <video.mp4> <audio.m4a> <out.mp4>") }
  await mux(videoPath: arguments[1], audioPath: arguments[2], outPath: arguments[3])
case "still":
  guard arguments.count == 4, let seconds = Double(arguments[2]) else { fail("Usage: encode still <video.mp4> <seconds> <out.png>") }
  await still(videoPath: arguments[1], seconds: seconds, outPath: arguments[3])
default:
  encode(arguments)
}
