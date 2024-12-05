"use client";

import Image from "next/image";
import { useRef, useState, useEffect } from "react";

// グローバル型定義の拡張
declare global {
  interface Window {
    stream: MediaStream | null;
  }
  interface WebSocket {
    _pingTimer?: number;
  }
}

// 設定の追加
const sslPort = 8080;
const peerConnectionConfig: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.stunprotocol.org:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
  ]
};

export default function Home() {
  const localVideo = useRef<HTMLVideoElement>(null);
  const remoteVideo = useRef<HTMLVideoElement>(null);
  const [localId, setLocalId] = useState<string>('');
  const [remoteId, setRemoteId] = useState<string>('');
  let sc: WebSocket | null = null;
  let pc: RTCPeerConnection | null = null;
  let queue: any[] = [];

  useEffect(() => {
    const initializeConnection = async () => {
      let tempLocalId = '';
      let tempRemoteId = '';
      
      while (!tempLocalId) {
        tempLocalId = window.prompt('Local ID', '') || '';
      }
      while (!tempRemoteId) {
        tempRemoteId = window.prompt('Remote ID', '') || '';
      }
      
      setLocalId(tempLocalId);
      setRemoteId(tempRemoteId);
      startVideo(tempLocalId, tempRemoteId);
    };

    initializeConnection();
  }, []);

  function startVideo(localId: string, remoteId: string) {
    if (navigator.mediaDevices.getUserMedia) {
      if (window.stream) {
        // 既存のストリームを破棄
        try {
          window.stream.getTracks().forEach(track => {
            track.stop();
          });
        } catch (error) {
          console.error(error);
        }
        window.stream = null;
      }
      // カメラとマイクの開始
      const constraints = {
        audio: true,
        video: true
      };
      navigator.mediaDevices.getUserMedia(constraints).then(stream => {
        window.stream = stream;
        if (localVideo.current) {
          localVideo.current.srcObject = stream;
        }
        startServerConnection(localId, remoteId);
      }).catch(e => {
        alert('Camera start error.\n\n' + e.name + ': ' + e.message);
      });
    } else {
      alert('Your browser does not support getUserMedia API');
    }
  }

  function stopVideo() {
    if (remoteVideo.current && remoteVideo.current.srcObject) {
      try {
        (remoteVideo.current.srcObject as MediaStream).getTracks().forEach(track => {
          track.stop();
        });
      } catch (error) {
        console.error(error);
      }
      remoteVideo.current.srcObject = null;
    }
  }

  function startServerConnection(localId: string, remoteId: string) {
    if (sc) {
      sc.close();
    }
    // サーバー接続の開始
    sc = new WebSocket('ws://' + location.hostname + ':' + sslPort + '/');
    sc.onmessage = gotMessageFromServer;
    sc.onopen = function (event) {
      // サーバーに接続情報を通知
      this.send(JSON.stringify({ open: { local: localId, remote: remoteId } }));
    };
    sc.onclose = function (event) {
      clearInterval(this._pingTimer);
      setTimeout(conn => {
        if (sc === conn) {
          // 一定時間経過後にサーバーへ再接続
          startServerConnection(localId, remoteId);
        }
      }, 5000, this);
    }
    sc._pingTimer = setInterval(() => {
      // 接続確認
      sc.send(JSON.stringify({ ping: 1 }));
    }, 30000);
  }

  function startPeerConnection(sdpType: string) {
    stopPeerConnection();
    queue = new Array();
    pc = new RTCPeerConnection(peerConnectionConfig);
    pc.onicecandidate = function (event) {
      if (event.candidate) {
        // ICE送信
        sc?.send(JSON.stringify({ ice: event.candidate, remote: remoteId }));
      }
    };
    if (window.stream) {
      // Local側のストリームを設定
      window.stream.getTracks().forEach(track => pc?.addTrack(track, window.stream));
    }
    pc.ontrack = function (event) {
      // Remote側のストリームを設定
      if (event.streams && event.streams[0]) {
        if (remoteVideo.current) {
          remoteVideo.current.srcObject = event.streams[0];
        }
      } else {
        if (remoteVideo.current) {
          remoteVideo.current.srcObject = new MediaStream([event.track]);
        }
      }
    };
    if (sdpType === 'offer') {
      // Offerの作成
      pc.createOffer().then(setDescription).catch(errorHandler);
    }
  }

  function stopPeerConnection() {
    if (pc) {
      pc.close();
      pc = null;
    }
  }

  function gotMessageFromServer(message: MessageEvent) {
    const signal = JSON.parse(message.data);
    if (signal.start) {
      // サーバーからの「start」を受けてPeer接続を開始する
      startPeerConnection(signal.start);
      return;
    }
    if (signal.close) {
      // 接続先の終了通知
      stopVideo();
      stopPeerConnection();
      return;
    }
    if (signal.ping) {
      sc?.send(JSON.stringify({ pong: 1 }));
      return;
    }
    if (!pc) {
      return;
    }
    // 以降はWebRTCのシグナリング処理
    if (signal.sdp) {
      // SDP受信
      if (signal.sdp.type === 'offer') {
        pc.setRemoteDescription(signal.sdp).then(() => {
          // Answerの作成
          pc.createAnswer().then(setDescription).catch(errorHandler);
        }).catch(errorHandler);
      } else if (signal.sdp.type === 'answer') {
        pc.setRemoteDescription(signal.sdp).catch(errorHandler);
      }
    }
    if (signal.ice) {
      // ICE受信
      if (pc.remoteDescription) {
        pc.addIceCandidate(new RTCIceCandidate(signal.ice)).catch(errorHandler);
      } else {
        // SDPが未処理のためキューに貯める
        queue.push(message);
        return;
      }
    }
    if (queue.length > 0 && pc.remoteDescription) {
      // キューのメッセージを再処理
      gotMessageFromServer(queue.shift());
    }
  }

  function setDescription(description: RTCSessionDescriptionInit) {
    pc?.setLocalDescription(description).then(() => {
      // SDP送信
      sc?.send(JSON.stringify({ sdp: pc.localDescription, remote: remoteId }));
    }).catch(errorHandler);
  }

  function errorHandler(error: Error) {
    alert('Signaling error.\n\n' + error.name + ': ' + error.message);
  }

  return (
    <>
      Local
      <video ref={localVideo} playsInline autoPlay muted></video>
      Remote
      <video ref={remoteVideo} playsInline autoPlay></video>
    </>
  );
}


