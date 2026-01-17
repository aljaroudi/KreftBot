import { VideoTransformService } from './src/services/VideoTransformService';
import { stat } from 'fs/promises';

const videoService = new VideoTransformService();
const testVideo = '/tmp/kreftbot-test/test_video.mp4';

async function test() {
  console.log('Testing VideoTransformService...\n');

  try {
    // Test 1: Get video info
    console.log('1. Testing getVideoInfo()...');
    const info = await videoService.getVideoInfo(testVideo);
    console.log('✅ Video Info:', {
      duration: `${info.duration.toFixed(2)}s`,
      size: `${(info.fileSize / 1024).toFixed(2)} KB`,
      resolution: `${info.width}x${info.height}`,
      codec: info.codec,
      hasAudio: info.hasAudio,
    });

    // Test 2: Extract audio
    console.log('\n2. Testing extractAudio()...');
    const audioPath = await videoService.extractAudio(testVideo);
    const audioStat = await stat(audioPath);
    console.log('✅ Audio extracted:', {
      path: audioPath,
      size: `${(audioStat.size / 1024).toFixed(2)} KB`,
    });

    // Test 3: Test error handling for too small target
    console.log('\n3. Testing error handling for too small target...');
    try {
      await videoService.optimizeVideo(testVideo, 0.05);
      console.log('❌ Should have thrown error for too small target');
    } catch (error: any) {
      console.log('✅ Correctly rejected too small target:', error.message);
    }

    // Test 4: Test "already small enough" error
    console.log('\n4. Testing error handling for already small video...');
    try {
      await videoService.optimizeVideo(testVideo, 1); // Video is ~161KB, target is 1MB
      console.log('❌ Should have thrown error for already small video');
    } catch (error: any) {
      console.log('✅ Correctly detected video is already small:', error.message);
    }

    // Create a larger test video for compression
    console.log('\n5. Creating larger test video for compression test...');
    const { spawn } = await import('bun');
    const proc = spawn([
      'ffmpeg', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=30:size=1920x1080:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=30',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'fast', '-b:v', '8000k',
      '-c:a', 'aac', '-b:a', '192k',
      '/tmp/kreftbot-test/large_video.mp4'
    ]);
    await proc.exited;

    const largeInfo = await videoService.getVideoInfo('/tmp/kreftbot-test/large_video.mp4');
    const largeSizeMB = largeInfo.fileSize / (1024 * 1024);
    console.log(`✅ Large test video created (${largeSizeMB.toFixed(2)}MB)`);

    // Test 6: Test progress tracking
    console.log('\n6. Testing compressWithProgress() with 5MB target...');
    let lastPercent = 0;
    const progressPath = await videoService.compressWithProgress(
      '/tmp/kreftbot-test/large_video.mp4',
      5, // 5MB target
      (percent) => {
        if (percent - lastPercent >= 20) {
          console.log(`   Progress: ${Math.floor(percent)}%`);
          lastPercent = percent;
        }
      }
    );
    const progressStat = await stat(progressPath);
    const finalSizeMB = progressStat.size / (1024 * 1024);
    const targetSize = 5;
    const accuracyPercent = ((finalSizeMB / targetSize) - 1) * 100;
    console.log('✅ Video compressed with progress:', {
      size: `${finalSizeMB.toFixed(2)} MB`,
      target: `${targetSize}.00 MB`,
      accuracy: `${accuracyPercent.toFixed(1)}% off target`,
    });

    console.log('\n✅ All tests passed!');
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

test();
