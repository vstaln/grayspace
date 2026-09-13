import React from 'react';
import {AbsoluteFill, Composition, OffthreadVideo, registerRoot, staticFile} from 'remotion';

const BugRecording = () => (
  <AbsoluteFill style={{backgroundColor: 'black'}}>
    <OffthreadVideo
      src={staticFile('bug-recording.mp4')}
      style={{width: '100%', height: '100%', objectFit: 'contain'}}
    />
  </AbsoluteFill>
);

const Root = () => (
  <Composition
    id="BugRecording"
    component={BugRecording}
    durationInFrames={360}
    fps={30}
    width={1440}
    height={910}
  />
);

registerRoot(Root);
