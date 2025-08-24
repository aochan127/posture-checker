# v3b スタンドアロン骨組み

このフォルダを **GitHub Pages のリポジトリ直下**に置き、さらに以下のファイルを追加してください（CDN不要でAIが動きます）。

```
/vendor/
  tf.min.js                    ← @tensorflow/tfjs の UMD バンドル
  pose-detection.min.js        ← @tensorflow-models/pose-detection の UMD バンドル
/models/movenet/
  model.json                   ← MoveNet (SinglePose Lightning) の TFJS モデル定義
  *.bin                        ← model.json に記載の shard をすべて
```

index.html はこれらの **ローカルファイル**を参照します。

- `<script src="./vendor/tf.min.js">`
- `<script src="./vendor/pose-detection.min.js">`
- `poseDetection.createDetector(..., { modelUrl: './models/movenet/model.json' })`

> 置き場所やファイル名が違うと読み込めません。配置後に AI ボタンを押すと、右下のログに読み込み状況が出ます。

